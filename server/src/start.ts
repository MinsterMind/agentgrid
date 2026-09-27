import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, watch } from "node:fs";
import { Store } from "./store/store.js";
import { Manager } from "./runner/manager.js";
import { createApp } from "./api/app.js";
import { resolveHome } from "./store/paths.js";
import { readTranscript } from "./transcript.js";
import { openTerminal, runInTerminal } from "./terminal.js";
import { PtyManager, type SpawnFn } from "./pty.js";
import * as nodePty from "node-pty";
import { attachPtyWebSocket } from "./api/ws.js";
import { listAllSessions, listLiveSessions, LiveSessionWatcher } from "./sessions.js";
import { SessionStatusWatcher } from "./sessionStatus.js";
import { BugTaskStore } from "./bugfix/store.js";
import { IntegrationsStore, type Integrations } from "./bugfix/integrations.js";
import { GitOps } from "./bugfix/git.js";
import { makeForge } from "./bugfix/forge/index.js";
import { mcpTracker, type TrackerProvider } from "./bugfix/tracker.js";
import { BugFixEngine, recoverStuckBugTasks } from "./bugfix/engine.js";
import { PrWatcher } from "./bugfix/watcher.js";
import { fakeAgentQuery } from "./fake/agent.js";
import { fakeForge, type ScriptedStep } from "./fake/forge.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StartOptions {
  /** Data directory (default: resolveHome(), i.e. AGENTGRID_HOME or ~/.agentgrid). */
  home?: string;
  /** 0 picks a free port. Default: AGENTGRID_PORT or 4800. */
  port?: number;
  /** Top of the folder tree the Spawn dialog may browse. Default: AGENTGRID_BROWSE_ROOT or the home directory. */
  browseRoot?: string;
  /** Built UI directory. Default: ui/dist next to the repo, or server/ui-dist. */
  staticDir?: string;
  /** Directory holding the default role templates. Default: server/roles. */
  defaultsDir?: string;
  /** Directory holding the bug-fix tracker/stage presets. Default: server/presets. */
  presetsDir?: string;
  /** Scripted runner/terminal/sessions — no Claude Code needed (used by e2e). Default: AGENTGRID_FAKE. */
  fake?: boolean;
  /** Fake mode only: scripts the fake forge's PR story for the watcher to discover. */
  fakePrScript?: ScriptedStep[];
  log?: (msg: string) => void;
}

export interface RunningServer { port: number; url: string; home: string; close(): Promise<void> }

/** Parses `AGENTGRID_FAKE_PR_SCRIPT` (a JSON array of `ScriptedStep`) into `fakePrScript`.
 *  Undefined input (the env var unset) is fine — fake mode without a script is a normal,
 *  supported thing. But if the var IS set and isn't valid JSON, or isn't an array, that's a
 *  typo the caller needs to know about immediately: failing loudly at startup beats booting a
 *  server that silently runs with no script, which just makes whatever depends on that script
 *  (an e2e's Playwright web server, say) hang waiting for a story that never arrives. */
export function parseFakePrScript(raw: string | undefined): ScriptedStep[] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`AGENTGRID_FAKE_PR_SCRIPT is not valid JSON: ${(err as Error).message}`); }
  if (!Array.isArray(parsed)) throw new Error("AGENTGRID_FAKE_PR_SCRIPT must be a JSON array of ScriptedStep");
  return parsed as ScriptedStep[];
}

// Scripted runner for UI e2e: every assignment asks one permission, then succeeds.

/** Boot the whole AgentGrid server (store, runners, API, PTY bridge, live-session watcher) and listen on loopback. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? console.log;
  const fake = opts.fake ?? Boolean(process.env.AGENTGRID_FAKE);
  const home = opts.home ?? resolveHome();
  const defaultsDir = opts.defaultsDir ?? path.resolve(here, "..", "roles");
  const staticDir = opts.staticDir ?? [path.resolve(here, "..", "..", "ui", "dist"), path.resolve(here, "..", "ui-dist")].find(p => existsSync(p));

  const store = new Store(home, defaultsDir);
  await store.init();
  const manager = new Manager(store, fake ? { queryFn: fakeAgentQuery, buildOptions: (_r, a, e) => ({ cwd: a.repo, canUseTool: e.canUseTool, abortController: e.abortController }) } : {});
  await manager.recoverOnStart();

  let rolesReloadTimer: NodeJS.Timeout | null = null;
  const rolesWatcher = watch(store.rolesDir, () => {
    if (rolesReloadTimer) clearTimeout(rolesReloadTimer);
    // Debounce: editors often emit a burst of events (write + rename) for one save.
    rolesReloadTimer = setTimeout(() => { void store.reloadRoles().catch(err => log(`roles reload failed: ${err.message}`)); }, 100);
  });
  rolesWatcher.on("error", err => log(`roles watcher: ${err.message}`));

  // Fake mode serves a canned session list and a plain shell instead of `claude`.
  const fakeSessions = fake ? { live: async () => [{ sessionId: "fake-live-bg", cwd: "/tmp", name: "Fake background task", kind: "background" as const, status: "blocked" as const, startedAt: Date.now() - 60_000, bgId: "fake1" }], history: async () => [{ sessionId: "fake-old-session", cwd: "/tmp", title: "Earlier work (fake)", lastActiveAt: Date.now() }] } : undefined;
  const fakeSpawn: SpawnFn = (_file, args, o) => nodePty.spawn("/bin/sh", ["-c", `echo "AgentGrid fake terminal (claude ${args.join(" ")})"; exec cat`], o);
  const ptys = new PtyManager(fake ? fakeSpawn : undefined);
  store.gridPids = () => ptys.pids();
  const watcher = new LiveSessionWatcher(fakeSessions ? fakeSessions.live : listLiveSessions, live => store.setLiveSessions(live), 5000);
  watcher.start();

  // Follow the transcript of every session a grid agent is bound to (adopted or running), so Details/notifications work even when the work happens in the embedded terminal.
  const statuses = new SessionStatusWatcher(st => store.setSessionStatus(st), 1500);
  const syncWatched = () => {
    const want = new Map<string, string>();
    for (const a of store.listAgents()) {
      if (a.resumeSessionId) want.set(a.resumeSessionId, a.repo);
      const cur = a.currentAssignmentId ? store.getAssignment(a.currentAssignmentId) : null;
      if (cur?.sessionId) want.set(cur.sessionId, a.repo);
    }
    for (const sid of statuses.list().map(x => x.sessionId)) if (!want.has(sid)) statuses.unwatch(sid);
    for (const [sid, cwd] of want) statuses.watch(sid, cwd);
  };
  store.on("event", e => { if (e.type === "agent" || e.type === "agent-removed" || e.type === "assignment") syncWatched(); });
  syncWatched(); statuses.start();

  const bugStore = new BugTaskStore(home);
  await bugStore.init();
  store.bugTasks = () => bugStore.list();
  bugStore.on("event", e => store.emit("event", e));
  // Recovery only needs the bug store — run it unconditionally, whether or not a tracker
  // is configured (and so whether or not a BugFixEngine exists below), so a task stranded
  // mid-stage by an unclean shutdown always gets a card and a working Retry rather than
  // being silently orphaned on a server that has no tracker wired up yet.
  // A failure here is a bug in the bug-fix workflow, not a reason the whole server should
  // refuse to boot — log it and keep going rather than letting it reach `server.listen`
  // uncaught.
  await recoverStuckBugTasks(bugStore).catch(err => log(`bugfix: startup recovery failed: ${(err as Error).message}`));

  const integrations = new IntegrationsStore(home);
  // A corrupt integrations.json must not stop the server booting — the grid works without a
  // tracker or forge — but it must not pass unmentioned either: booting with an empty config
  // silently strips the tracker, the forge and the project->repo memory. Say it, then carry on
  // with nothing configured.
  const cfg = await integrations.read().catch((err: Error) => {
    log(`bugfix: ${err.message}`);
    return { projectRepos: {} } as Integrations;
  });
  const presetsDir = opts.presetsDir ?? path.resolve(here, "..", "presets");

  // Fake mode: a canned tracker and forge so the whole flow can be exercised without Jira or gh.
  const fakeTracker: TrackerProvider = {
    listMyIssues: async () => [{ key: "FAKE-1", title: "Fake bug for demos", url: "https://example.invalid/FAKE-1", status: "Open", priority: "High" }],
    fetchIssue: async (ref: string) => ({ key: ref.split("/").pop() || "FAKE-1", title: "Fake bug for demos", url: "https://example.invalid/FAKE-1",
      status: "Open", priority: "High", description: "A fake ticket used in fake mode.", acceptanceCriteria: ["it stops happening"] }),
    comment: async () => {},
  };
  const tracker = fake ? fakeTracker : (cfg.tracker ? mcpTracker(cfg.tracker, presetsDir) : null);
  // Only read the script in fake mode: it is used nowhere else, and a stale malformed value left
  // in a real deployment's environment would otherwise throw here and stop the server booting.
  const fakePrScript = fake ? (opts.fakePrScript ?? parseFakePrScript(process.env.AGENTGRID_FAKE_PR_SCRIPT)) : undefined;
  const forge = fake ? fakeForge(fakePrScript ?? []) : makeForge(cfg.forge);
  const engine = tracker ? new BugFixEngine({ store, bugs: bugStore, manager, git: new GitOps(), integrations, tracker, forge, presetsDir }) : null;
  // Recovery already ran above (`recoverStuckBugTasks`, tracker or no tracker) —
  // `BugFixEngine` has no recovery step of its own to call.
  if (engine) engine.attach();

  // The watcher polls the forge for tasks resting on an open PR and hands findings to the
  // engine, which stays the only writer of task state. In fake mode it ticks fast so the
  // offline tests and the e2e advance without waiting real minutes.
  const prWatcher = engine && forge
    ? new PrWatcher({ bugs: bugStore, forge, onFinding: f => engine.onPrFinding(f).catch(err => log(`bugfix: watcher finding failed: ${(err as Error).message}`)),
        onChecked: (id, at) => engine.onPrChecked(id, at).catch(err => log(`bugfix: recording the poll failed: ${(err as Error).message}`)),
        ...(fake ? { baseMs: 200, ceilingMs: 1_000 } : {}) })
    : null;
  prWatcher?.start(fake ? 100 : 1_000);

  const app = createApp({ store, manager, writeToTerminal: (sid, data) => ptys.write(sid, data), transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), fullTranscript: (cwd, sid) => readTranscript(cwd, sid, { full: true }),
    openTerminal, runInTerminal, staticDir, browseRoot: opts.browseRoot ?? process.env.AGENTGRID_BROWSE_ROOT, ...(fakeSessions ? { sessions: fakeSessions } : {}),
    ...(engine && tracker ? { bugs: { engine, store: bugStore, integrations, tracker } } : {}) });
  const server = http.createServer(app);
  attachPtyWebSocket(server, { store, ptys, sessions: () => listAllSessions(store.listAgents(), store.assignmentSessionIds(), fakeSessions) });

  const port = opts.port ?? Number(process.env.AGENTGRID_PORT ?? 4800);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const bound = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${bound}`;
  log(`AgentGrid on ${url}  (data: ${home}${staticDir ? "" : ", UI not built"})`);
  return {
    port: bound, url, home,
    close: () => new Promise<void>(resolve => { watcher.stop(); statuses.stop(); prWatcher?.stop(); rolesWatcher.close(); ptys.closeAll(); server.close(() => resolve()); }),
  };
}
