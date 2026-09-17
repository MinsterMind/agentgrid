import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { Store } from "../store/store.js";
import { Manager } from "../runner/manager.js";
import { sseHandler } from "./sse.js";
import { shellQuote } from "../shell.js";
import { listDir } from "../fs.js";
import { pickFolder } from "../picker.js";
import os from "node:os";
import type { Agent, Assignment, Decision } from "../types.js";

export interface AppDeps {
  store: Store;
  manager: Manager;
  transcript?: (assignment: Assignment, agent: Agent) => Promise<unknown[]>;
  openTerminal?: (repo: string, sessionId: string) => Promise<void>;
  staticDir?: string;
  /** Root the repo browser may list; defaults to the home directory. */
  browseRoot?: string;
  /** Native folder chooser; resolves null on cancel. Defaults to the macOS picker. */
  pickFolder?: (startDir: string) => Promise<string | null>;
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
  app.get("/api/agents/:id/memory", wrap(async (req, res) => res.json(await store.listMemory(req.params.id as string))));

  app.post("/api/agents/:id/open-terminal", wrap(async (req, res) => {
    const agent = store.getAgent(req.params.id as string);
    const asg = agent.currentAssignmentId ? store.getAssignment(agent.currentAssignmentId) : null;
    if (!asg?.sessionId) throw new BadRequest("no session to open");
    const command = `cd ${shellQuote(agent.repo)} && claude --resume ${shellQuote(asg.sessionId)}`;
    if (deps.openTerminal) await deps.openTerminal(agent.repo, asg.sessionId);
    res.json({ command, opened: Boolean(deps.openTerminal) });
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
