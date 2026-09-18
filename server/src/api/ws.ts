import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../store/store.js";
import type { PtyManager } from "../pty.js";
import type { SessionInfo } from "../types.js";

export interface WsDeps { store: Store; ptys: PtyManager; sessions: () => Promise<SessionInfo[]> }

/** Where and how to start `claude` for a session id: attach for background sessions, resume otherwise. */
export async function resolveLaunch(sessionId: string, deps: WsDeps): Promise<{ cwd: string; argv: string[] } | { error: string; code: number }> {
  const bySession = new Map<string, string>(); // sessionId → agentId, via any assignment that ran it
  for (const a of deps.store.listAssignments(Number.MAX_SAFE_INTEGER)) if (a.sessionId) bySession.set(a.sessionId, a.agentId);
  for (const a of deps.store.listAgents()) {
    const owns = a.resumeSessionId === sessionId || bySession.get(sessionId) === a.id;
    if (!owns) continue;
    const cur = a.currentAssignmentId ? deps.store.getAssignment(a.currentAssignmentId) : null;
    const runningIt = (a.state === "working" || a.state === "waiting") && (cur?.sessionId === sessionId || a.resumeSessionId === sessionId);
    if (runningIt) return { error: `agent ${a.displayName} is running this session — wait for it to finish or cancel it`, code: 4409 };
    const live = deps.store.liveSessions().find(l => l.sessionId === sessionId);
    if (live?.kind === "interactive" && live.owner !== "grid") return { error: "session is open in a terminal already", code: 4409 };
    if (live?.bgId) return { cwd: a.repo, argv: ["attach", live.bgId] };
    return { cwd: a.repo, argv: ["--resume", sessionId] };
  }
  const info = (await deps.sessions()).find(s => s.sessionId === sessionId);
  if (!info) return { error: "unknown session", code: 4404 };
  if (info.kind === "interactive" && info.owner !== "grid") return { error: "session is open in a terminal already", code: 4409 };
  if (info.bgId) return { cwd: info.cwd, argv: ["attach", info.bgId] };
  return { cwd: info.cwd, argv: ["--resume", sessionId] };
}

/** ws://host/api/pty/<sessionId>?cols=&rows=  — binary frames carry terminal bytes; text frames are JSON control messages. */
export function attachPtyWebSocket(server: http.Server, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/api\/pty\/([^/]+)$/);
    if (!m) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => void serve(ws, decodeURIComponent(m[1]), url));
  });

  async function serve(ws: WebSocket, sessionId: string, url: URL) {
    const cols = Math.max(20, Number(url.searchParams.get("cols")) || 80);
    const rows = Math.max(5, Number(url.searchParams.get("rows")) || 24);
    const launch = await resolveLaunch(sessionId, deps);
    if ("error" in launch) { ws.close(launch.code, launch.error); return; }
    const handle = deps.ptys.attach(sessionId, { ...launch, cols, rows },
      data => { if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, "utf8")); },
      reason => { if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason); });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) { handle.write(raw.toString("utf8")); return; }
      try { const msg = JSON.parse(raw.toString()); if (msg.type === "resize") handle.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0)); else if (msg.type === "kill") handle.kill(); } catch { /* ignore */ }
    });
    ws.on("close", () => handle.detach());
  }
  return wss;
}
