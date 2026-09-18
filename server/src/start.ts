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
import type { QueryFn } from "./runner/runner.js";

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
  /** Scripted runner/terminal/sessions — no Claude Code needed (used by e2e). Default: AGENTGRID_FAKE. */
  fake?: boolean;
  log?: (msg: string) => void;
}

export interface RunningServer { port: number; url: string; home: string; close(): Promise<void> }

// Scripted runner for UI e2e: every assignment asks one permission, then succeeds.
const fakeQuery: QueryFn = ({ options }) => (async function* () {
  yield { type: "system", subtype: "init", session_id: `fake-${Date.now()}` } as any;
  yield { type: "assistant", message: { content: [{ type: "text", text: "Thinking about it…" }] } } as any;
  const r = await options.canUseTool!("Bash", { command: "echo hi" }, { signal: options.abortController!.signal, toolUseID: `tu-${Date.now()}` } as any);
  if (r!.behavior === "deny") { yield { type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, is_error: true } as any; return; }
  yield { type: "result", subtype: "success", result: "All done (fake).", num_turns: 2, total_cost_usd: 0.02, duration_ms: 1, is_error: false } as any;
})();

/** Boot the whole AgentGrid server (store, runners, API, PTY bridge, live-session watcher) and listen on loopback. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? console.log;
  const fake = opts.fake ?? Boolean(process.env.AGENTGRID_FAKE);
  const home = opts.home ?? resolveHome();
  const defaultsDir = opts.defaultsDir ?? path.resolve(here, "..", "roles");
  const staticDir = opts.staticDir ?? [path.resolve(here, "..", "..", "ui", "dist"), path.resolve(here, "..", "ui-dist")].find(p => existsSync(p));

  const store = new Store(home, defaultsDir);
  await store.init();
  const manager = new Manager(store, fake ? { queryFn: fakeQuery, buildOptions: (_r, a, e) => ({ cwd: a.repo, canUseTool: e.canUseTool, abortController: e.abortController }) } : {});
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

  const app = createApp({ store, manager, transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), fullTranscript: (cwd, sid) => readTranscript(cwd, sid, { full: true }),
    openTerminal, runInTerminal, staticDir, browseRoot: opts.browseRoot ?? process.env.AGENTGRID_BROWSE_ROOT, ...(fakeSessions ? { sessions: fakeSessions } : {}) });
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
    close: () => new Promise<void>(resolve => { watcher.stop(); rolesWatcher.close(); ptys.closeAll(); server.close(() => resolve()); }),
  };
}
