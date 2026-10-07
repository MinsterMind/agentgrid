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
import { PtyManager, hookCommand, hookSettings, type SpawnFn } from "./pty.js";
import { randomBytes } from "node:crypto";
import { RulesStore } from "./permissions/rules.js";
import { PermissionBroker } from "./permissions/broker.js";
import * as nodePty from "node-pty";
import { attachPtyWebSocket } from "./api/ws.js";
import { listAllSessions, listLiveSessions, LiveSessionWatcher } from "./sessions.js";
import { SessionStatusWatcher } from "./sessionStatus.js";
import { BugTaskStore } from "./bugfix/store.js";
import { IntegrationsStore, type Integrations } from "./bugfix/integrations.js";
import { GitOps } from "./bugfix/git.js";
import { makeForge } from "./bugfix/forge/index.js";
import { AgentPrWatcher } from "./agentpr.js";
import { ConflictWatcher } from "./bugfix/conflicts.js";
import { TrackerCache } from "./bugfix/trackerCache.js";
import { TrackerSync } from "./bugfix/trackerSync.js";
import { BatchStarter } from "./bugfix/batch.js";
import { mcpTracker, type TrackerProvider } from "./bugfix/tracker.js";
import { BugFixEngine, recoverStuckBugTasks } from "./bugfix/engine.js";
import { PrWatcher } from "./bugfix/watcher.js";
import { fakeAgentQuery } from "./fake/agent.js";
import { fakeForge, type ScriptedStep, type FakeForge } from "./fake/forge.js";

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

/** Fake mode only: every status move the fake tracker was asked to make (tests read it). */
export const fakeTrackerMoves: Array<{ key: string; name: string }> = [];

export interface RunningServer {
  port: number; url: string; home: string;
  /** Fake mode only: the test-only handle on the forge that served this server, so an
   *  in-process test can assert on its call counts (e.g. exactly one `createPr`) without
   *  a debug HTTP endpoint. Undefined outside fake mode. */
  fakeForge?: FakeForge;
  /** Test-only accessor to the live-wired bug-fix engine, if one exists. */
  bugEngineForTest?: () => BugFixEngine | undefined;
  close(): Promise<void>;
}

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
  // Shared always-allow rules, and the broker that holds embedded terminals' permission requests.
  const rules = new RulesStore(home); await rules.load();
  if (rules.problem) log(`permissions: ${rules.problem}`);
  const permissionBroker = new PermissionBroker(rules);
  permissionBroker.on("event", e => store.emit("event", e));
  store.permissions = () => permissionBroker.list();
  const manager = new Manager(store, fake ? { queryFn: fakeAgentQuery, buildOptions: (_r, a, e) => ({ cwd: a.repo, canUseTool: e.canUseTool, abortController: e.abortController }), rules } : { rules });
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
  // A session's open requests end with its process: nothing is left to answer them.
  ptys.onSessionExit(sid => permissionBroker.cancelSession(sid));
  let hookToken: string | null = null;
  /** The agent a session belongs to — the same ownership rule the Terminal tab uses (api/ws.ts). */
  const agentForSession = (sid: string): string | null => {
    for (const a of store.listAgents()) if (a.resumeSessionId === sid) return a.id;
    return store.listAssignments(Number.MAX_SAFE_INTEGER).find(x => x.sessionId === sid)?.agentId ?? null;
  };
  store.gridPids = () => ptys.pids();
  const watcher = new LiveSessionWatcher(fakeSessions ? fakeSessions.live : listLiveSessions, live => store.setLiveSessions(live), 5000);
  watcher.start();

  // Follow the transcript of every session a grid agent is bound to (adopted or running), so Details/notifications work even when the work happens in the embedded terminal.
  const statuses = new SessionStatusWatcher(st => { store.setSessionStatus(st); permissionBroker.reconcile(st); }, 1500);
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
    listMyIssues: async () => [
      { key: "FAKE-1", title: "Fake bug for demos", url: "https://example.invalid/FAKE-1", status: "Open", priority: "High" },
      { key: "FAKE-2", title: "A second fake bug", url: "https://example.invalid/FAKE-2", status: "To Do", priority: "Medium" },
    ],
    fetchIssue: async (ref: string) => {
      const key = ref.split("/").pop() || "FAKE-1";
      return { key, title: key === "FAKE-2" ? "A second fake bug" : "Fake bug for demos", url: `https://example.invalid/${key}`,
        status: "Open", priority: "High", description: "A fake ticket used in fake mode.", acceptanceCriteria: ["it stops happening"] };
    },
    comment: async () => {},
    fetchIssues: async (keys: string[]) => ({ issues: await Promise.all(keys.map(k => fakeTracker.fetchIssue(k))), missing: [] }),
    listTransitions: async () => [{ id: "11", name: "Start Progress", to: "In Progress" }, { id: "21", name: "Submit for Review", to: "In Review" }, { id: "31", name: "Done", to: "Done" }],
    transition: async (key: string, name: string) => {
      const to = { "Start Progress": "In Progress", "Submit for Review": "In Review", Done: "Done" }[name];
      fakeTrackerMoves.push({ key, name });
      return to ? { ok: true as const, status: to } : { ok: false as const, error: `no transition named "${name}"` };
    },
  };
  // Only read the script in fake mode: it is used nowhere else, and a stale malformed value left
  // in a real deployment's environment would otherwise throw here and stop the server booting.
  const fakePrScript = fake ? (opts.fakePrScript ?? parseFakePrScript(process.env.AGENTGRID_FAKE_PR_SCRIPT)) : undefined;
  const fakeForgeHandle = fake ? fakeForge(fakePrScript ?? []) : null;

  let wiredBugFix: { engine: BugFixEngine; store: BugTaskStore; integrations: IntegrationsStore; tracker: TrackerProvider; trackerCache?: TrackerCache; batches?: BatchStarter } | undefined;
  let wiredWatcher: PrWatcher | null = null;
  let wiredConflicts: ConflictWatcher | null = null;
  let wiredCache: TrackerCache | null = null;
  let lastCfg = cfg;

  /**
   * Builds the bug-fix subsystem from a configuration. Returns `null` when there is still no
   * tracker — the one thing the workflow cannot run without. Safe to call again only while
   * nothing is wired: `createApp` enforces the absent→present-once rule.
   */
  const wireBugFix = async (config: Integrations) => {
    lastCfg = config;
    const tracker = fake ? fakeTracker : (config.tracker ? mcpTracker(config.tracker, presetsDir) : null);
    if (!tracker) return null;
    const forge = fakeForgeHandle ?? makeForge(config.forge);
    // Tracker reads are model runs: answer from a cache that refreshes itself (spec 2026-10-08 §3.3).
    await wiredCache?.flush().catch(() => {});
    wiredCache = new TrackerCache({ tracker, file: path.join(home, "tracker-cache.json") });
    await wiredCache.load();
    wiredCache.on("event", e => store.emit("event", e));
    const trackerCache = wiredCache;
    const engine = new BugFixEngine({ store, bugs: bugStore, manager, git: new GitOps(), integrations, tracker, forge, presetsDir, trackerCache });
    // Tickets move through the user's workflow as the fix goes on (spec 2026-10-08 §4).
    engine.setTrackerSync(new TrackerSync({ tracker, bugs: bugStore, statusMap: async () => (await integrations.read()).statusMap }));
    engine.attach();
    wiredWatcher?.stop();
    wiredWatcher = forge
      ? new PrWatcher({ bugs: bugStore, forge, onFinding: f => engine.onPrFinding(f).catch(err => log(`bugfix: watcher finding failed: ${(err as Error).message}`)),
          onChecked: (id, at) => engine.onPrChecked(id, at).catch(err => log(`bugfix: recording the poll failed: ${(err as Error).message}`)),
          ...(fake ? { baseMs: 200, ceilingMs: 1_000 } : {}) })
      : null;
    wiredWatcher?.start(fake ? 100 : 1_000);
    // Conflicts across every resting PR, from local git — no forge calls (spec 2026-10-07 §4.1).
    wiredConflicts?.stop();
    wiredConflicts = new ConflictWatcher({ bugs: bugStore, git: new GitOps(),
      onFinding: f => engine.onConflictFinding(f).catch(err => log(`bugfix: conflict finding failed: ${(err as Error).message}`)),
      onProblem: (id, m) => engine.onConflictProblem(id, m).catch(() => {}),
      intervalMs: fake ? 500 : 60_000 });
    engine.setConflictNudge(repo => wiredConflicts?.nudge(repo));
    wiredConflicts.start();
    const batches = new BatchStarter({ engine, git: new GitOps(), tracker, cache: trackerCache });
    batches.on("event", e => store.emit("event", e));
    wiredBugFix = { engine, store: bugStore, integrations, tracker, trackerCache, batches };
    return wiredBugFix;
  };

  await wireBugFix(cfg);

  // The PR an agent's task names, with its status, on the agent's card (any role: a reviewer, or a coder fixing review comments).
  const agentPrs = new AgentPrWatcher({ store, forge: () => fakeForgeHandle ?? makeForge(lastCfg.forge) });
  agentPrs.start();

  const app = createApp({ store, manager, permissions: { broker: permissionBroker, rules }, ...(fake ? { fakePermissions: true } : {}), hookToken: () => hookToken, agentForSession, submitToTerminal: (sid, text) => ptys.submit(sid, text), transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), fullTranscript: (cwd, sid) => readTranscript(cwd, sid, { full: true }),
    openTerminal, runInTerminal, staticDir, browseRoot: opts.browseRoot ?? process.env.AGENTGRID_BROWSE_ROOT, ...(fakeSessions ? { sessions: fakeSessions } : {}),
    integrations,
    roleResolves: () => { try { store.getRole("bugfix"); return true; } catch { return false; } },
    trackerPresetResolves: (preset: string) => existsSync(path.join(presetsDir, "tracker", `${preset}.md`)),
    setupForge: () => fakeForgeHandle ?? makeForge(lastCfg.forge),
    setupRepo: () => {
      const repos = lastCfg.projectRepos;
      if (!repos || Object.keys(repos).length === 0) return undefined;
      // Return any available repo (first by insertion order; any one is acceptable per the brief)
      return Object.values(repos)[0];
    },
    onConfigured: async () => (await wireBugFix(await integrations.read())) ?? null,
    onConfigSaved: cfg => { lastCfg = cfg; },
    ...(wiredBugFix ? { bugs: wiredBugFix } : {}) });
  const server = http.createServer(app);
  attachPtyWebSocket(server, { store, ptys, sessions: () => listAllSessions(store.listAgents(), store.assignmentSessionIds(), fakeSessions) });

  const port = opts.port ?? Number(process.env.AGENTGRID_PORT ?? 4800);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const bound = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${bound}`;
  // Only now is the URL known: from here on, embedded terminals ask AgentGrid for permission.
  hookToken = randomBytes(32).toString("hex");
  ptys.configureHook({
    settings: hookSettings(hookCommand(process.execPath, path.join(presetsDir, "hooks", "permission-hook.mjs"), !!process.versions.electron)),
    env: { AGENTGRID_URL: url, AGENTGRID_HOOK_TOKEN: hookToken },
  });
  log(`AgentGrid on ${url}  (data: ${home}${staticDir ? "" : ", UI not built"})`);
  return {
    port: bound, url, home,
    ...(fakeForgeHandle ? { fakeForge: fakeForgeHandle } : {}),
    bugEngineForTest: () => wiredBugFix?.engine,
    close: () => new Promise<void>(resolve => { watcher.stop(); statuses.stop(); agentPrs.stop(); wiredWatcher?.stop(); wiredConflicts?.stop(); void wiredCache?.flush().catch(() => {}); rolesWatcher.close(); ptys.closeAll(); server.close(() => resolve()); }),
  };
}
