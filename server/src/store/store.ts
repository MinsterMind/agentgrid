import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { paths } from "./paths.js";
import { loadRoles, ensureDefaultRoles } from "./roles.js";
import type { Agent, Assignment, GridEvent, GridState, MemoryFile, RoleDef } from "../types.js";

export class NotFound extends Error { status = 404; }
export class Conflict extends Error { status = 409; }

const NAMES = ["Ada", "Rhea", "Cody", "Tess", "Dev", "Demi", "Kai", "Ravi", "Maya", "Tom", "Ira", "Max", "Nia", "Ola", "Zed"];

let seq = 0;
async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

export class Store extends EventEmitter {
  private p; private roles: RoleDef[] = [];
  private agents = new Map<string, Agent>();
  private assignments = new Map<string, Assignment>();
  private nextAssignment = 1;

  constructor(home: string, private defaultsDir: string) {
    super();
    this.p = paths(home);
  }

  async init(): Promise<void> {
    await mkdir(this.p.agents, { recursive: true });
    await mkdir(this.p.archived, { recursive: true });
    await mkdir(this.p.assignments, { recursive: true });
    await ensureDefaultRoles(this.p.roles, this.defaultsDir);
    this.roles = await loadRoles(this.p.roles);
    for (const f of (await readdir(this.p.agents)).filter(f => f.endsWith(".json"))) {
      const a = JSON.parse(await readFile(path.join(this.p.agents, f), "utf8")) as Agent;
      this.agents.set(a.id, a);
    }
    for (const f of (await readdir(this.p.assignments)).filter(f => f.endsWith(".json"))) {
      const a = JSON.parse(await readFile(path.join(this.p.assignments, f), "utf8")) as Assignment;
      this.assignments.set(a.id, a);
      const n = Number(a.id.slice(1));
      if (n >= this.nextAssignment) this.nextAssignment = n + 1;
    }
  }

  async reloadRoles(): Promise<void> {
    this.roles = await loadRoles(this.p.roles);
    this.emit("event", { type: "roles", roles: this.roles } satisfies GridEvent);
  }
  get rolesDir() { return this.p.roles; }

  // ---- roles
  listRoles(): RoleDef[] { return this.roles; }
  getRole(name: string): RoleDef {
    const r = this.roles.find(r => r.name === name);
    if (!r) throw new NotFound(`role ${name}`);
    return r;
  }

  // ---- agents
  listAgents(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  getAgent(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new NotFound(`agent ${id}`);
    return a;
  }
  async createAgent(input: { role: string; repo: string; displayName?: string }): Promise<Agent> {
    this.getRole(input.role);
    const base = `${input.role}@${path.basename(input.repo)}`;
    let id = base; let n = 2;
    while (this.agents.has(id)) id = `${base}-${n++}`;
    const agent: Agent = {
      id, role: input.role, repo: input.repo,
      displayName: input.displayName?.trim() || NAMES[this.agents.size % NAMES.length],
      createdAt: new Date().toISOString(), state: "free", currentAssignmentId: null,
    };
    await mkdir(this.p.memoryDir(id), { recursive: true });
    await writeAtomic(this.p.agentFile(id), agent);
    this.agents.set(id, agent);
    this.emit("event", { type: "agent", agent } satisfies GridEvent);
    return agent;
  }
  async updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
    const next = { ...this.getAgent(id), ...patch, id };
    await writeAtomic(this.p.agentFile(id), next);
    this.agents.set(id, next);
    this.emit("event", { type: "agent", agent: next } satisfies GridEvent);
    return next;
  }
  async archiveAgent(id: string): Promise<void> {
    this.getAgent(id);
    // The same live id can be reused after an earlier archive (createAgent only checks
    // live ids for collisions), so a prior archive dir may already sit at `_archived/id`.
    // Never rename onto it — that would either fail (ENOTEMPTY) or silently clobber the
    // previous agent's memory. Suffix with a timestamp instead so both are preserved.
    let target = path.join(this.p.archived, id);
    if (await stat(target).then(() => true, () => false)) {
      target = path.join(this.p.archived, `${id}.${Date.now()}`);
    }
    await rename(this.p.agentDir(id), target);
    await rm(this.p.agentFile(id));
    this.agents.delete(id);
    this.emit("event", { type: "agent-removed", id } satisfies GridEvent);
  }
  memoryDir(id: string): string { return this.p.memoryDir(id); }
  async listMemory(id: string): Promise<MemoryFile[]> {
    this.getAgent(id);
    const dir = this.p.memoryDir(id);
    const out: MemoryFile[] = [];
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith(".md") && f !== "MEMORY.md").sort()) {
      const { data } = matter(await readFile(path.join(dir, f), "utf8"));
      out.push({ file: f, name: String(data.name ?? f.replace(/\.md$/, "")), description: String(data.description ?? "") });
    }
    return out;
  }
  async readMemoryIndex(id: string): Promise<string> {
    return readFile(path.join(this.p.memoryDir(id), "MEMORY.md"), "utf8").catch(() => "");
  }

  // ---- assignments (Task 4)
  listAssignments(limit = 50): Assignment[] {
    const all = [...this.assignments.values()];
    const active = all.filter(a => a.state === "working" || a.state === "waiting");
    const rest = all.filter(a => !(a.state === "working" || a.state === "waiting"))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.id.slice(1)) - Number(a.id.slice(1)))
      .slice(0, limit);
    return [...active, ...rest];
  }
  getAssignment(id: string): Assignment {
    const a = this.assignments.get(id);
    if (!a) throw new NotFound(`assignment ${id}`);
    return a;
  }
  async createAssignment(input: { agentId: string; prompt: string }): Promise<Assignment> {
    this.getAgent(input.agentId);
    const a: Assignment = {
      id: `a${this.nextAssignment++}`, agentId: input.agentId, prompt: input.prompt,
      createdAt: new Date().toISOString(), startedAt: null, endedAt: null, sessionId: null,
      state: "working", activity: "Starting…", pending: null, outcome: null, error: null, turns: 0, costUsd: 0,
    };
    await writeAtomic(this.p.assignmentFile(a.id), a);
    this.assignments.set(a.id, a);
    this.emit("event", { type: "assignment", assignment: a } satisfies GridEvent);
    return a;
  }
  async updateAssignment(id: string, patch: Partial<Assignment>): Promise<Assignment> {
    const next = { ...this.getAssignment(id), ...patch, id };
    await writeAtomic(this.p.assignmentFile(id), next);
    this.assignments.set(id, next);
    this.emit("event", { type: "assignment", assignment: next } satisfies GridEvent);
    return next;
  }

  getState(): GridState {
    return { roles: this.listRoles(), agents: this.listAgents(), assignments: this.listAssignments() };
  }
}
