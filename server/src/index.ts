#!/usr/bin/env node
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
import { listAllSessions } from "./sessions.js";
import type { QueryFn } from "./runner/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultsDir = path.resolve(here, "..", "roles");
const uiDist = [path.resolve(here, "..", "..", "ui", "dist"), path.resolve(here, "..", "ui-dist")].find(p => existsSync(p));

// Scripted runner for UI e2e: every assignment asks one permission, then succeeds.
const fakeQuery: QueryFn = ({ options }) => (async function* () {
  yield { type: "system", subtype: "init", session_id: `fake-${Date.now()}` } as any;
  yield { type: "assistant", message: { content: [{ type: "text", text: "Thinking about it…" }] } } as any;
  const r = await options.canUseTool!("Bash", { command: "echo hi" }, { signal: options.abortController!.signal, toolUseID: `tu-${Date.now()}` } as any);
  if (r!.behavior === "deny") { yield { type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, is_error: true } as any; return; }
  yield { type: "result", subtype: "success", result: "All done (fake).", num_turns: 2, total_cost_usd: 0.02, duration_ms: 1, is_error: false } as any;
})();

async function serve() {
  const store = new Store(resolveHome(), defaultsDir);
  await store.init();
  const manager = new Manager(store, process.env.AGENTGRID_FAKE ? { queryFn: fakeQuery, buildOptions: (_r, a, e) => ({ cwd: a.repo, canUseTool: e.canUseTool, abortController: e.abortController }) } : {});
  await manager.recoverOnStart();
  let rolesReloadTimer: NodeJS.Timeout | null = null;
  const rolesWatcher = watch(store.rolesDir, () => {
    if (rolesReloadTimer) clearTimeout(rolesReloadTimer);
    // Debounce: editors often emit a burst of events (write + rename) for one save.
    rolesReloadTimer = setTimeout(() => {
      void store.reloadRoles().catch(err => console.error("roles reload failed:", err.message));
    }, 100);
  });
  rolesWatcher.on("error", err => console.error("roles watcher:", err.message));
  // Fake mode serves a canned session list so the UI/e2e can exercise adoption without Claude Code.
  const fakeSessions = process.env.AGENTGRID_FAKE ? { live: async () => [], history: async () => [{ sessionId: "fake-old-session", cwd: "/tmp", title: "Earlier work (fake)", lastActiveAt: Date.now() }] } : undefined;
  // Fake mode: a plain shell stands in for `claude` so the terminal pane can be exercised without the CLI.
  const fakeSpawn: SpawnFn = (_file, args, opts) => nodePty.spawn("/bin/sh", ["-c", `echo "AgentGrid fake terminal (claude ${args.join(" ")})"; exec cat`], opts);
  const ptys = new PtyManager(process.env.AGENTGRID_FAKE ? fakeSpawn : undefined);
  const app = createApp({ store, manager, transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), fullTranscript: (cwd, sid) => readTranscript(cwd, sid, { full: true }), openTerminal, runInTerminal, staticDir: uiDist, browseRoot: process.env.AGENTGRID_BROWSE_ROOT,
    ...(fakeSessions ? { sessions: fakeSessions } : {}) });
  const port = Number(process.env.AGENTGRID_PORT ?? 4800);
  const server = http.createServer(app);
  attachPtyWebSocket(server, { store, ptys, sessions: () => listAllSessions(store.listAgents(), store.assignmentSessionIds(), fakeSessions) });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { ptys.closeAll(); process.exit(0); });
  // Without this handler, a bind failure (most commonly EADDRINUSE — some other
  // process, or a previous `agentgrid serve`, already holds the port) surfaces as a
  // raw uncaught-exception stack trace. Report it plainly and exit instead.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} already in use — set AGENTGRID_PORT to another port`);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => console.log(`AgentGrid on http://127.0.0.1:${port}  (data: ${resolveHome()}${uiDist ? "" : ", UI not built"})`));
}

const cmd = process.argv[2];
if (cmd === "serve") serve().catch(err => { console.error(err); process.exit(1); });
else { console.log("usage: agentgrid serve"); process.exit(cmd ? 1 : 0); }
