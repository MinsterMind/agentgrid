import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { Store, NotFound, Conflict } from "../store/store.js";
import { Manager } from "../runner/manager.js";
import { sseHandler } from "./sse.js";
import { shellQuote } from "../shell.js";
import { listDir } from "../fs.js";
import { pickFolder } from "../picker.js";
import { attachCommand } from "../terminal.js";
import { listAllSessions, listHistorySessions, getHistorySession, renameSession, takeOverSession, type LiveSession, type HistorySession } from "../sessions.js";
import os from "node:os";
import type { Agent, Assignment, Decision, SessionInfo } from "../types.js";

export interface AppDeps {
  store: Store;
  manager: Manager;
  transcript?: (assignment: Assignment, agent: Agent) => Promise<unknown[]>;
  /** Full, untruncated transcript of a session in a repo. */
  fullTranscript?: (cwd: string, sessionId: string) => Promise<unknown[]>;
  openTerminal?: (repo: string, sessionId: string) => Promise<void>;
  /** Run an arbitrary shell command in a new terminal window (used for `claude attach`). */
  runInTerminal?: (shell: string) => Promise<void>;
  staticDir?: string;
  /** Root the repo browser may list; defaults to the home directory. */
  browseRoot?: string;
  /** Native folder chooser; resolves null on cancel. Defaults to the macOS picker. */
  pickFolder?: (startDir: string) => Promise<string | null>;
  /** Session sources (tests inject stubs). */
  sessions?: { live: () => Promise<LiveSession[]>; history: () => Promise<HistorySession[]>; lookup?: (id: string) => Promise<HistorySession | null>; rename?: (id: string, title: string) => Promise<void> };
  /** Test hook: how to close a foreign terminal session (default SIGTERM). */
  killSession?: (pid: number) => void;
  /** Type text into a session's embedded terminal; false when none is open. */
  writeToTerminal?: (sessionId: string, data: string) => boolean;
}

class BadRequest extends Error { status = 400; }

function isDecision(d: unknown): d is Decision {
  if (!d || typeof d !== "object") return false;
  const k = (d as any).kind;
  if (k === "allow" || k === "always") return true;
  if (k === "deny") return true;
  if (k === "answers") return typeof (d as any).answers === "object" && (d as any).answers !== null;
  return false;
}

export function createApp(deps: AppDeps) {
  const { store, manager } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

  app.get("/api/state", wrap((_req, res) => res.json(store.getState())));
  app.get("/api/events", sseHandler(store));
  app.get("/api/fs", wrap(async (req, res) => {
    const p = req.query.path;
    if (p !== undefined && typeof p !== "string") throw new BadRequest("path must be a string");
    res.json(await listDir(deps.browseRoot ?? os.homedir(), p));
  }));
  const sessions = () => listAllSessions(store.listAgents(), store.assignmentSessionIds(), { live: async () => store.rawLiveSessions(), history: deps.sessions?.history ?? listHistorySessions, gridPids: store.gridPids });
  const lookup = deps.sessions?.lookup ?? getHistorySession;
  /** Session by id from the merged list, else straight from Claude Code (outside the recent window). */
  const findSession = async (sid: string): Promise<SessionInfo | null> => {
    const hit = (await sessions()).find(s => s.sessionId === sid);
    if (hit) return hit;
    const h = await lookup(sid);
    if (!h) return null;
    const owned = store.listAgents().find(a => a.resumeSessionId === sid);
    return { sessionId: h.sessionId, cwd: h.cwd, title: h.title, kind: "history", status: "ended", at: h.lastActiveAt, ...(owned ? { agentId: owned.id } : {}), canAdopt: !owned };
  };
  app.get("/api/sessions", wrap(async (_req, res) => res.json(await sessions())));
  app.post("/api/sessions/:sessionId/adopt", wrap(async (req, res) => {
    const { role, displayName, takeover } = req.body ?? {};
    if (typeof role !== "string") throw new BadRequest("role is required");
    const sid = req.params.sessionId as string;
    const info = await findSession(sid);
    if (!info) throw new NotFound(`session ${sid} — not found in Claude Code's history`);
    if (!info.canAdopt) throw new Conflict(`session already on the grid as ${info.agentId}`);
    if (takeover && info.kind === "interactive") {
      // Close it in the other terminal first so the grid becomes the only writer, then push the fresh live list.
      const live = store.rawLiveSessions().find(l => l.sessionId === sid);
      if (!live) throw new Conflict("session is no longer live");
      const fetch = deps.sessions?.live ?? (() => import("../sessions.js").then(m => m.listLiveSessions()));
      store.setLiveSessions(await takeOverSession(live, { fetch, kill: deps.killSession }));
    }
    res.status(201).json(await store.createAgent({ role, repo: info.cwd, displayName, resumeSessionId: sid }));
  }));
  app.get("/api/sessions/:sessionId", wrap(async (req, res) => {
    const info = await findSession(req.params.sessionId as string);
    if (!info) throw new NotFound("session not found");
    res.json(info);
  }));
  app.post("/api/sessions/:sessionId/rename", wrap(async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) throw new BadRequest("title is required");
    const sid = req.params.sessionId as string;
    if (!(await findSession(sid))) throw new NotFound("session not found");
    await (deps.sessions?.rename ?? renameSession)(sid, title);
    res.status(204).end();
  }));
  app.post("/api/sessions/:sessionId/attach", wrap(async (req, res) => {
    const sid = req.params.sessionId as string;
    const info = (await sessions()).find(s => s.sessionId === sid);
    if (!info) throw new NotFound(`session ${sid}`);
    if (!info.bgId) throw new BadRequest("only background sessions can be attached");
    const command = attachCommand(info.bgId);
    if (deps.runInTerminal) await deps.runInTerminal(command);
    res.json({ command, opened: Boolean(deps.runInTerminal) });
  }));
  app.post("/api/fs/pick", wrap(async (_req, res) => {
    const pick = deps.pickFolder ?? pickFolder;
    const chosen = await pick(deps.browseRoot ?? os.homedir());
    if (chosen === null) res.status(204).end(); else res.json({ path: chosen });
  }));

  app.post("/api/agents", wrap(async (req, res) => {
    const { role, repo, displayName } = req.body ?? {};
    if (typeof role !== "string" || typeof repo !== "string" || !path.isAbsolute(repo)) throw new BadRequest("role and absolute repo are required");
    res.status(201).json(await store.createAgent({ role, repo, displayName }));
  }));
  app.delete("/api/agents/:id", wrap(async (req, res) => { await manager.archive(req.params.id as string); res.status(204).end(); }));

  app.post("/api/agents/:id/assign", wrap(async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) throw new BadRequest("prompt is required");
    res.status(201).json(await manager.assign(req.params.id as string, prompt));
  }));
  app.post("/api/agents/:id/answer", wrap(async (req, res) => {
    const { toolUseId, decision } = req.body ?? {};
    if (typeof toolUseId !== "string" || !isDecision(decision)) throw new BadRequest("toolUseId and decision are required");
    await manager.answer(req.params.id as string, toolUseId, decision); res.status(204).end();
  }));
  app.post("/api/agents/:id/cancel", wrap(async (req, res) => { await manager.cancel(req.params.id as string); res.status(204).end(); }));
  app.post("/api/agents/:id/ack", wrap(async (req, res) => { await manager.ack(req.params.id as string); res.status(204).end(); }));
  /** Forget an adopted session so the next task starts fresh (bug: pulled-in agent kept old context forever). */
  app.post("/api/agents/:id/reset", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    if (agent.state !== "free" && agent.state !== "done" && agent.state !== "failed") throw new Conflict(`agent is ${agent.state}`);
    if (agent.resumeSessionId && store.isLive(agent.resumeSessionId) && store.liveSessions().find(l => l.sessionId === agent.resumeSessionId)?.owner !== "grid") throw new Conflict("session is open in a terminal — close it first");
    res.json(await store.clearResumeSession(agent.id));
  }));
  /** Reply to the agent's session from Details: goes into the embedded terminal if one is open, else starts a grid assignment. */
  app.post("/api/agents/:id/say", wrap(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) throw new BadRequest("text is required");
    const agent = store.getAgent(req.params.id as string);
    const sid = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId).sessionId : agent.resumeSessionId;
    if (sid && deps.writeToTerminal?.(sid, text.replace(/\r?\n$/, "") + "\r")) { res.json({ via: "terminal" }); return; }
    if (agent.state !== "free") throw new Conflict(`agent is ${agent.state} and has no open terminal`);
    res.status(201).json({ via: "assignment", assignment: await manager.assign(agent.id, text) });
  }));
  app.get("/api/agents/:id/memory", wrap(async (req, res) => res.json(await store.listMemory(req.params.id as string))));

  app.post("/api/agents/:id/open-terminal", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const asg = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    if (!asg?.sessionId) throw new BadRequest("no session to open");
    const command = `cd ${shellQuote(agent.repo)} && claude --resume ${shellQuote(asg.sessionId)}`;
    if (deps.openTerminal) await deps.openTerminal(agent.repo, asg.sessionId);
    res.json({ command, opened: Boolean(deps.openTerminal) });
  }));
  app.get("/api/agents/:id/transcript", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const current = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    const last = store.listAssignments(Number.MAX_SAFE_INTEGER).filter(a => a.agentId === agent.id && a.sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const sessionId = current?.sessionId ?? agent.resumeSessionId ?? last?.sessionId ?? null;
    if (!sessionId) { res.json({ sessionId: null, entries: [] }); return; }
    res.json({ sessionId, entries: deps.fullTranscript ? await deps.fullTranscript(agent.repo, sessionId) : [] });
  }));
  app.get("/api/assignments/:id/transcript", wrap(async (req, res) => {
    const asg = store.getAssignment(req.params.id as string);
    const agent = store.getAgent(asg.agentId);
    res.json(deps.transcript ? await deps.transcript(asg, agent) : []);
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  if (deps.staticDir) {
    app.use(express.static(deps.staticDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(deps.staticDir!, "index.html")));
  }

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err?.message ?? "internal error" });
  });
  return app;
}
