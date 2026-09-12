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
import { openTerminal } from "./terminal.js";
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
  const app = createApp({ store, manager, transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), openTerminal, staticDir: uiDist });
  const port = Number(process.env.AGENTGRID_PORT ?? 4800);
  http.createServer(app).listen(port, "127.0.0.1", () => console.log(`AgentGrid on http://127.0.0.1:${port}  (data: ${resolveHome()}${uiDist ? "" : ", UI not built"})`));
}

const cmd = process.argv[2];
if (cmd === "serve") serve().catch(err => { console.error(err); process.exit(1); });
else { console.log("usage: agentgrid serve"); process.exit(cmd ? 1 : 0); }
