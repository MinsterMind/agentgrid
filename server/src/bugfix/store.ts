import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { NotFound } from "../store/store.js";
import { TERMINAL_STAGES, type BugTask, type TrackerIssue, type Transition } from "./types.js";

let seq = 0;
const writeChains = new Map<string, Promise<void>>();
/** Same atomic, per-file-serialised write the agent store uses. */
function writeAtomic(file: string, data: unknown): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, file);
  });
  writeChains.set(file, next);
  next.finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); }).catch(() => {});
  return next;
}

export interface CreateBugTask {
  issue: TrackerIssue; trackerProject: string; sourceRepo: string; worktree: string;
  branch: string; baseBranch: string; agentId: string;
  mergePolicy: "ask" | "auto"; mergeMethod: "squash" | "merge" | "rebase";
}

/** Bug tasks on disk: one JSON file per task plus a directory of artifacts. */
export class BugTaskStore extends EventEmitter {
  private tasks = new Map<string, BugTask>();
  private next = 1;
  private root: string;
  constructor(home: string) { super(); this.root = path.join(home, "bugtasks"); }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const f of (await readdir(this.root)).filter(f => f.endsWith(".json"))) {
      const t = JSON.parse(await readFile(path.join(this.root, f), "utf8")) as BugTask;
      this.tasks.set(t.id, t);
      const n = Number(t.id.slice(2));
      if (n >= this.next) this.next = n + 1;
    }
  }

  /** Only ever accept our own id shape — a route param must not be usable to escape the store root. */
  private safeId(id: string): string {
    if (!/^bt\d+$/.test(id)) throw new NotFound(`bug task ${id}`);
    return id;
  }
  /** Artifact names are plain filenames — no separators, no dot-segments. */
  private safeName(name: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      throw new Error(`invalid artifact name: ${name}`);
    }
    return name;
  }
  /** Belt and braces: whatever the joined path resolves to must stay under the task's directory. */
  private safeArtifactPath(id: string, name: string): string {
    const base = path.resolve(this.dir(id));
    const full = path.resolve(base, this.safeName(name));
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`invalid artifact name: ${name}`);
    }
    return full;
  }

  private file(id: string) { return path.join(this.root, `${this.safeId(id)}.json`); }
  dir(id: string) { return path.join(this.root, this.safeId(id)); }

  list(): BugTask[] { return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get(id: string): BugTask {
    this.safeId(id);
    const t = this.tasks.get(id);
    if (!t) throw new NotFound(`bug task ${id}`);
    return t;
  }
  /** The agent's live task, if any — terminal tasks don't count, so an agent can be reused. */
  byAgent(agentId: string): BugTask | null {
    return this.list().find(t => t.agentId === agentId && !TERMINAL_STAGES.includes(t.stage)) ?? null;
  }

  async create(input: CreateBugTask): Promise<BugTask> {
    const now = new Date().toISOString();
    const task: BugTask = {
      id: `bt${this.next++}`, ...input, stage: "intake", gate: null, pr: null,
      costUsd: 0, history: [{ stage: "intake", at: now, note: "" }], error: null,
      createdAt: now, updatedAt: now,
    };
    await mkdir(this.dir(task.id), { recursive: true });
    await this.save(task);
    return task;
  }

  /** Apply a stage-machine transition: move stage, append history, set/clear the gate and error. */
  async apply(id: string, t: Transition): Promise<BugTask> {
    const cur = this.get(id);
    const now = new Date().toISOString();
    return this.save({ ...cur, stage: t.stage, gate: t.gate, error: t.error, updatedAt: now,
      history: [...cur.history, { stage: t.stage, at: now, note: t.note }] });
  }

  async patch(id: string, p: Partial<BugTask>): Promise<BugTask> {
    return this.save({ ...this.get(id), ...p, id, updatedAt: new Date().toISOString() });
  }

  private async save(task: BugTask): Promise<BugTask> {
    await writeAtomic(this.file(task.id), task);
    this.tasks.set(task.id, task);
    this.emit("event", { type: "bugtask", task });
    return task;
  }

  async writeArtifact(id: string, name: string, data: string): Promise<void> {
    this.get(id);
    const file = this.safeArtifactPath(id, name);
    await mkdir(this.dir(id), { recursive: true });
    await writeFile(file, data);
  }
  async readArtifact(id: string, name: string): Promise<string | null> {
    this.get(id);
    const file = this.safeArtifactPath(id, name);
    return readFile(file, "utf8").catch(() => null);
  }
}
