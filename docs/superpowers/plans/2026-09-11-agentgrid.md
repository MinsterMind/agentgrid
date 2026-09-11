# AgentGrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard showing a roster of persona agents (role × repo), each backed by a fresh Claude Agent SDK session per assignment, with inline handling of permissions/questions and hand-off to `claude --resume`.

**Architecture:** One Node/TypeScript server owns a file store under `~/.agentgrid/`, runs one `Runner` per agent instance around the SDK `query()` (injected, so tests use a scripted fake), and exposes a small REST + SSE API. A Vite/React UI renders a fixed grid of tiles plus a side panel, driven by one reducer fed from `/api/state` and `/api/events`.

**Tech Stack:** Node ≥ 22, TypeScript 5, npm workspaces, `@anthropic-ai/claude-agent-sdk` 0.3.268 (pinned to CLI 2.1.268), Express 5, gray-matter, vitest, supertest, Vite 6 + React 19, @testing-library/react, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-agentgrid-design.md`

## Global Constraints

- SDK and CLI are version-locked: pin `@anthropic-ai/claude-agent-sdk` to `0.3.268` exactly (no caret).
- Data root is `~/.agentgrid/`, overridable with `AGENTGRID_HOME` (tests always set it to a temp dir).
- Server listens on `127.0.0.1:4800` only (`AGENTGRID_PORT` overrides). No auth.
- Every role must set `model` explicitly (SDK defaults to sonnet otherwise).
- Assignment prompt format is exactly spec §8.1 (snapshot-tested).
- Agent state machine is exactly spec §5.5; `done`/`failed` are sticky until `ack`.
- Grid order is creation order and is never re-sorted.
- Dark theme only; keyboard shortcuts per spec §7.3.
- Commit after every task with a conventional-commit message; end commit messages with the attribution trailer configured for this session.
- Deviation from spec, approved by the user during planning: `maxBudgetUsd` per role is passed to the SDK (`Options.maxBudgetUsd` exists), so cost-based abort ships in v1.

---

## File structure

```
agentgrid/                                  (repo root = /Users/manojmali/MinsterMind/hrns)
  package.json                              npm workspaces: server, ui; root scripts
  tsconfig.base.json
  server/
    package.json
    tsconfig.json
    vitest.config.ts
    roles/                                  default role templates copied to ~/.agentgrid/roles on first run
      architect.md coder.md reviewer.md tester.md devops.md demo-prep.md
    src/
      types.ts                              all domain types (Role, Agent, Assignment, Pending, Decision, GridEvent)
      store/paths.ts                        home dir resolution + per-entity paths
      store/roles.ts                        parse role .md files → RoleDef
      store/store.ts                        Store: agents/assignments CRUD, atomic writes, event emitter
      prompt/assemble.ts                    spec §8.1 prompt builder
      runner/runner.ts                      Runner: one agent's state machine around query()
      runner/manager.ts                     Manager: runners by agentId, restart recovery
      runner/sdk.ts                         real QueryFn + Options builder from RoleDef
      transcript.ts                         parse ~/.claude/projects/<enc>/<sessionId>.jsonl
      terminal.ts                           open Terminal.app / iTerm via osascript
      api/app.ts                            express app factory (routes)
      api/sse.ts                            /api/events handler
      index.ts                              CLI entry: `agentgrid serve`
    test/
      helpers/fakeQuery.ts                  scripted fake for query()
      roles.test.ts store.test.ts assemble.test.ts runner.test.ts manager.test.ts
      api.test.ts sse.test.ts transcript.test.ts live.test.ts
  ui/
    package.json vite.config.ts tsconfig.json index.html
    src/
      main.tsx App.tsx
      api.ts                                fetch wrappers + SSE subscription
      state/reducer.ts                      GridState + reducer + selectors
      components/TopBar.tsx SpawnDialog.tsx AgentGrid.tsx AgentTile.tsx SidePanel.tsx PendingPrompt.tsx AssignBox.tsx
      hooks/useKeyboard.ts
      notify.ts                             tab title + Notification API
      styles.css
    test/ reducer.test.ts AgentTile.test.tsx PendingPrompt.test.tsx
    e2e/smoke.spec.ts playwright.config.ts
```

---

### Task 1: Monorepo scaffold + domain types

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/types.ts`, `server/test/types.test.ts`

**Interfaces:**
- Produces: every type in `server/src/types.ts` (used by all later tasks verbatim).

- [ ] **Step 1: Root package files**

`package.json`:
```json
{
  "name": "agentgrid",
  "private": true,
  "workspaces": ["server", "ui"],
  "scripts": {
    "test": "npm run test -w server && npm run test -w ui",
    "build": "npm run build -w ui && npm run build -w server",
    "serve": "npm run serve -w server"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true, "declaration": false, "sourceMap": true
  }
}
```

`server/package.json`:
```json
{
  "name": "@agentgrid/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "agentgrid": "./dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "serve": "tsx src/index.ts serve",
    "test": "vitest run",
    "test:live": "AGENTGRID_LIVE=1 vitest run test/live.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.268",
    "express": "^5.1.0",
    "gray-matter": "^4.0.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.1",
    "@types/node": "^22.15.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

`server/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"] }
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 15000 } });
```

- [ ] **Step 2: Write the domain types**

`server/src/types.ts`:
```ts
export type AgentState = "free" | "working" | "waiting" | "done" | "failed";
export type AssignmentState = Exclude<AgentState, "free">;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type SettingSource = "user" | "project" | "local";

export interface RoleDef {
  name: string;
  avatar: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  settingSources: SettingSource[];
  allowedTools: string[];
  maxTurns: number;
  maxBudgetUsd?: number;
  prompt: string; // markdown body = persona/system prompt
}

export interface Agent {
  id: string;            // "<role>@<repoBasename>[-n]"
  role: string;
  repo: string;          // absolute path
  displayName: string;
  createdAt: string;     // ISO
  state: AgentState;
  currentAssignmentId: string | null;
}

export type Pending =
  | { kind: "permission"; toolUseId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] }
  | { kind: "question";   toolUseId: string; toolName: "AskUserQuestion"; input: Record<string, unknown>; suggestions: unknown[] };

export interface Assignment {
  id: string;            // "a<n>"
  agentId: string;
  prompt: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
  state: AssignmentState;
  activity: string;
  pending: Pending | null;
  outcome: string | null;
  error: string | null;
  turns: number;
  costUsd: number;
}

export type Decision =
  | { kind: "allow" }
  | { kind: "always" }
  | { kind: "deny"; message?: string }
  | { kind: "answers"; answers: Record<string, string>; response?: string };

export interface MemoryFile { file: string; name: string; description: string }

export type GridEvent =
  | { type: "agent"; agent: Agent }
  | { type: "agent-removed"; id: string }
  | { type: "assignment"; assignment: Assignment }
  | { type: "roles"; roles: RoleDef[] };

export interface GridState { roles: RoleDef[]; agents: Agent[]; assignments: Assignment[] }
```

- [ ] **Step 3: Smoke test that the toolchain runs**

`server/test/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { Agent } from "../src/types.js";
describe("types", () => {
  it("compiles and vitest runs", () => {
    const a: Agent = { id: "coder@x", role: "coder", repo: "/x", displayName: "Cody",
      createdAt: new Date().toISOString(), state: "free", currentAssignmentId: null };
    expect(a.state).toBe("free");
  });
});
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm test -w server`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json server
git commit -m "chore: scaffold monorepo, server package and domain types"
```

---

### Task 2: Paths + role loader + default roles

**Files:**
- Create: `server/src/store/paths.ts`, `server/src/store/roles.ts`, `server/roles/{architect,coder,reviewer,tester,devops,demo-prep}.md`, `server/test/roles.test.ts`

**Interfaces:**
- Produces: `resolveHome(): string`, `paths(home)` → `{ roles, agents, archived, assignments, agentDir(id), memoryDir(id) }`; `parseRole(markdown: string, fallbackName: string): RoleDef`; `loadRoles(rolesDir: string): Promise<RoleDef[]>`; `ensureDefaultRoles(rolesDir: string, defaultsDir: string): Promise<void>`.

- [ ] **Step 1: Failing tests**

`server/test/roles.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRole, loadRoles, ensureDefaultRoles } from "../src/store/roles.js";

const md = `---
name: reviewer
avatar: 🧐
model: claude-opus-5
effort: high
permissionMode: default
settingSources: [user, project]
allowedTools: [Read, Grep, "Bash(git *)"]
maxTurns: 40
maxBudgetUsd: 3
---
You review code.`;

describe("parseRole", () => {
  it("parses frontmatter and body", () => {
    const r = parseRole(md, "x");
    expect(r).toEqual({
      name: "reviewer", avatar: "🧐", model: "claude-opus-5", effort: "high",
      permissionMode: "default", settingSources: ["user", "project"],
      allowedTools: ["Read", "Grep", "Bash(git *)"], maxTurns: 40, maxBudgetUsd: 3,
      prompt: "You review code.",
    });
  });
  it("applies defaults and fallback name", () => {
    const r = parseRole(`---\nmodel: claude-opus-5\n---\nHi`, "coder");
    expect(r.name).toBe("coder");
    expect(r.avatar).toBe("🤖");
    expect(r.effort).toBe("high");
    expect(r.permissionMode).toBe("default");
    expect(r.settingSources).toEqual(["user", "project"]);
    expect(r.allowedTools).toEqual([]);
    expect(r.maxTurns).toBe(100);
    expect(r.maxBudgetUsd).toBeUndefined();
  });
  it("throws when model is missing", () => {
    expect(() => parseRole(`---\nname: a\n---\nx`, "a")).toThrow(/model/);
  });
});

describe("loadRoles / ensureDefaultRoles", () => {
  it("loads all .md files sorted by name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    await writeFile(path.join(dir, "b.md"), `---\nmodel: m\n---\nB`);
    await writeFile(path.join(dir, "a.md"), `---\nmodel: m\n---\nA`);
    const roles = await loadRoles(dir);
    expect(roles.map(r => r.name)).toEqual(["a", "b"]);
  });
  it("copies defaults only when the dir is empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    const defaults = path.resolve("roles");
    await ensureDefaultRoles(dir, defaults);
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["architect.md", "coder.md", "reviewer.md", "tester.md", "devops.md", "demo-prep.md"]));
    await writeFile(path.join(dir, "coder.md"), `---\nmodel: mine\n---\nmine`);
    await ensureDefaultRoles(dir, defaults);
    expect((await loadRoles(dir)).find(r => r.name === "coder")!.model).toBe("mine");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- roles`
Expected: FAIL — cannot find module `../src/store/roles.js`.

- [ ] **Step 3: Implement paths and roles**

`server/src/store/paths.ts`:
```ts
import os from "node:os";
import path from "node:path";

export function resolveHome(): string {
  return process.env.AGENTGRID_HOME ?? path.join(os.homedir(), ".agentgrid");
}

export function paths(home: string) {
  return {
    home,
    roles: path.join(home, "roles"),
    agents: path.join(home, "agents"),
    archived: path.join(home, "agents", "_archived"),
    assignments: path.join(home, "assignments"),
    agentDir: (id: string) => path.join(home, "agents", id),
    agentFile: (id: string) => path.join(home, "agents", `${id}.json`),
    memoryDir: (id: string) => path.join(home, "agents", id, "memory"),
    assignmentFile: (id: string) => path.join(home, "assignments", `${id}.json`),
  };
}
```

`server/src/store/roles.ts`:
```ts
import matter from "gray-matter";
import { readdir, readFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RoleDef } from "../types.js";

export function parseRole(markdown: string, fallbackName: string): RoleDef {
  const { data, content } = matter(markdown);
  if (typeof data.model !== "string" || !data.model) {
    throw new Error(`role "${data.name ?? fallbackName}": model is required`);
  }
  return {
    name: String(data.name ?? fallbackName),
    avatar: String(data.avatar ?? "🤖"),
    model: data.model,
    effort: data.effort ?? "high",
    permissionMode: data.permissionMode ?? "default",
    settingSources: data.settingSources ?? ["user", "project"],
    allowedTools: data.allowedTools ?? [],
    maxTurns: Number(data.maxTurns ?? 100),
    ...(data.maxBudgetUsd !== undefined ? { maxBudgetUsd: Number(data.maxBudgetUsd) } : {}),
    prompt: content.trim(),
  };
}

export async function loadRoles(rolesDir: string): Promise<RoleDef[]> {
  const files = (await readdir(rolesDir)).filter(f => f.endsWith(".md")).sort();
  const roles: RoleDef[] = [];
  for (const f of files) {
    roles.push(parseRole(await readFile(path.join(rolesDir, f), "utf8"), f.replace(/\.md$/, "")));
  }
  return roles;
}

export async function ensureDefaultRoles(rolesDir: string, defaultsDir: string): Promise<void> {
  await mkdir(rolesDir, { recursive: true });
  const existing = (await readdir(rolesDir)).filter(f => f.endsWith(".md"));
  if (existing.length > 0) return;
  for (const f of (await readdir(defaultsDir)).filter(f => f.endsWith(".md"))) {
    await copyFile(path.join(defaultsDir, f), path.join(rolesDir, f));
  }
}
```

- [ ] **Step 4: Write the six default roles**

All six share this footer line in the body: `End every task with a 2–3 line summary: what changed, what you verified, what is left.`

`server/roles/coder.md`:
```
---
name: coder
avatar: 👩‍💻
model: claude-opus-5
effort: xhigh
permissionMode: acceptEdits
settingSources: [user, project]
allowedTools: []
maxTurns: 150
maxBudgetUsd: 8
---
You are a senior software engineer working inside this repository. Follow the repo's existing conventions, write tests for behaviour you change, run them, and keep commits small. Never push. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/roles/reviewer.md`:
```
---
name: reviewer
avatar: 🧐
model: claude-opus-5
effort: high
permissionMode: default
settingSources: [user, project]
allowedTools: [Read, Grep, Glob, "Bash(git *)", "Bash(gh *)"]
maxTurns: 40
maxBudgetUsd: 3
---
You are a meticulous code reviewer. Review only; do not edit files. Report correctness bugs first, then risk, then simplification, each with file:line and a concrete failure scenario. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/roles/tester.md`:
```
---
name: tester
avatar: 🧪
model: claude-opus-5
effort: high
permissionMode: acceptEdits
settingSources: [user, project]
allowedTools: []
maxTurns: 100
maxBudgetUsd: 5
---
You are a QA engineer. Write and run end-to-end and integration tests, reproduce reported bugs with a failing test before anything else, and report exact commands and output. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/roles/devops.md`:
```
---
name: devops
avatar: 🛠️
model: claude-opus-5
effort: high
permissionMode: default
settingSources: [user, project]
allowedTools: [Read, Grep, Glob]
maxTurns: 80
maxBudgetUsd: 5
---
You are a DevOps engineer. Every command that changes infrastructure or a deployment must go through a permission prompt — never assume approval. Prefer read-only inspection first, state the blast radius before acting, and verify health after every change. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/roles/architect.md`:
```
---
name: architect
avatar: 🏛️
model: claude-opus-5
effort: xhigh
permissionMode: plan
settingSources: [user, project]
allowedTools: [Read, Grep, Glob, "Bash(git *)"]
maxTurns: 60
maxBudgetUsd: 5
---
You are a principal software architect. Read before you propose. Produce ADRs and design notes under docs/, with explicit trade-offs and a recommendation. Do not modify source code. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/roles/demo-prep.md`:
```
---
name: demo-prep
avatar: 🎤
model: claude-opus-5
effort: high
permissionMode: acceptEdits
settingSources: [user, project]
allowedTools: []
maxTurns: 80
maxBudgetUsd: 4
---
You prepare product demos. Produce a demo script (docs/demo/<date>.md), seed data or fixtures, and a pre-flight checklist of commands that must succeed before the demo. Rehearse the commands and fix anything broken. End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

- [ ] **Step 5: Run tests**

Run: `npm test -w server -- roles`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/store server/roles server/test/roles.test.ts
git commit -m "feat(server): role loader, paths and default role templates"
```

---

### Task 3: Store — agents

**Files:**
- Create: `server/src/store/store.ts`, `server/test/store.test.ts`

**Interfaces:**
- Produces: `class Store extends EventEmitter` with `constructor(home: string, defaultsDir: string)`, `init(): Promise<void>`, `listRoles(): RoleDef[]`, `getRole(name): RoleDef` (throws `NotFound`), `listAgents(): Agent[]`, `getAgent(id): Agent` (throws `NotFound`), `createAgent(input: {role; repo; displayName?}): Promise<Agent>`, `updateAgent(id, patch: Partial<Agent>): Promise<Agent>`, `archiveAgent(id): Promise<void>`, `memoryDir(id): string`, `listMemory(id): Promise<MemoryFile[]>`. Emits `"event"` with a `GridEvent`. Exports `class NotFound extends Error` and `class Conflict extends Error`.

- [ ] **Step 1: Failing tests**

`server/test/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, NotFound } from "../src/store/store.js";
import type { GridEvent } from "../src/types.js";

let home: string; let store: Store; let events: GridEvent[];
const defaults = path.resolve("roles");

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, defaults);
  events = [];
  store.on("event", e => events.push(e));
  await store.init();
});

describe("Store agents", () => {
  it("loads default roles on init", () => {
    expect(store.listRoles().map(r => r.name)).toContain("coder");
    expect(() => store.getRole("nope")).toThrow(NotFound);
  });

  it("creates an agent with derived id and default name, persists it, emits", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/tmp/proj/hrns" });
    expect(a.id).toBe("coder@hrns");
    expect(a.state).toBe("free");
    expect(a.displayName).toBeTruthy();
    const onDisk = JSON.parse(await readFile(path.join(home, "agents", "coder@hrns.json"), "utf8"));
    expect(onDisk).toEqual(a);
    expect((await stat(path.join(home, "agents", "coder@hrns", "memory"))).isDirectory()).toBe(true);
    expect(events).toEqual([{ type: "agent", agent: a }]);
  });

  it("suffixes ids on collision", async () => {
    await store.createAgent({ role: "coder", repo: "/a/hrns" });
    const b = await store.createAgent({ role: "coder", repo: "/b/hrns" });
    const c = await store.createAgent({ role: "coder", repo: "/c/hrns" });
    expect(b.id).toBe("coder@hrns-2");
    expect(c.id).toBe("coder@hrns-3");
  });

  it("rejects unknown role", async () => {
    await expect(store.createAgent({ role: "ghost", repo: "/x" })).rejects.toThrow(NotFound);
  });

  it("updates and reloads from disk", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await store.updateAgent(a.id, { state: "working", currentAssignmentId: "a1" });
    const s2 = new Store(home, defaults); await s2.init();
    expect(s2.getAgent(a.id)).toMatchObject({ state: "working", currentAssignmentId: "a1" });
  });

  it("archives: moves dir, removes json, emits removal", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await writeFile(path.join(store.memoryDir(a.id), "MEMORY.md"), "- x");
    await store.archiveAgent(a.id);
    expect(() => store.getAgent(a.id)).toThrow(NotFound);
    expect((await stat(path.join(home, "agents", "_archived", a.id, "memory", "MEMORY.md"))).isFile()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "agent-removed", id: a.id });
  });

  it("lists memory files with frontmatter", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await writeFile(path.join(store.memoryDir(a.id), "MEMORY.md"), "- [x](x.md)");
    await writeFile(path.join(store.memoryDir(a.id), "x.md"), "---\nname: x-fact\ndescription: a fact\n---\nbody");
    expect(await store.listMemory(a.id)).toEqual([{ file: "x.md", name: "x-fact", description: "a fact" }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Store (agents part; assignments added in Task 4)**

`server/src/store/store.ts`:
```ts
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { paths } from "./paths.js";
import { loadRoles, ensureDefaultRoles } from "./roles.js";
import type { Agent, Assignment, GridEvent, GridState, MemoryFile, RoleDef } from "../types.js";

export class NotFound extends Error { status = 404; }
export class Conflict extends Error { status = 409; }

const NAMES = ["Ada", "Rhea", "Cody", "Tess", "Dev", "Demi", "Kai", "Ravi", "Maya", "Tom", "Ira", "Max", "Nia", "Ola", "Zed"];

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
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
    await rename(this.p.agentDir(id), path.join(this.p.archived, id));
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
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- store`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/store/store.ts server/test/store.test.ts
git commit -m "feat(server): file-backed store for roles, agents and memory listing"
```

---

### Task 4: Store — assignments

**Files:**
- Modify: `server/test/store.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `Store` from Task 3 (assignment methods already implemented there).
- Produces: verified behaviour of `createAssignment`, `updateAssignment`, `listAssignments(limit)`, `getAssignment`, id counter persistence across restarts.

- [ ] **Step 1: Append failing tests**

Append to `server/test/store.test.ts`:
```ts
describe("Store assignments", () => {
  it("creates with sequential ids, working state, and emits", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    const s1 = await store.createAssignment({ agentId: a.id, prompt: "do x" });
    const s2 = await store.createAssignment({ agentId: a.id, prompt: "do y" });
    expect([s1.id, s2.id]).toEqual(["a1", "a2"]);
    expect(s1).toMatchObject({ state: "working", pending: null, costUsd: 0, turns: 0, sessionId: null });
    expect(events.filter(e => e.type === "assignment")).toHaveLength(2);
  });

  it("continues the id counter after restart", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await store.createAssignment({ agentId: a.id, prompt: "p" });
    const s2 = new Store(home, defaults); await s2.init();
    const next = await s2.createAssignment({ agentId: a.id, prompt: "q" });
    expect(next.id).toBe("a2");
  });

  it("lists active first, then most recent finished up to limit", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    const s1 = await store.createAssignment({ agentId: a.id, prompt: "1" });
    const s2 = await store.createAssignment({ agentId: a.id, prompt: "2" });
    const s3 = await store.createAssignment({ agentId: a.id, prompt: "3" });
    await store.updateAssignment(s1.id, { state: "done" });
    await store.updateAssignment(s2.id, { state: "failed" });
    const list = store.listAssignments(1);
    expect(list.map(x => x.id)).toEqual([s3.id, s2.id]);
  });

  it("rejects unknown agent / assignment", async () => {
    await expect(store.createAssignment({ agentId: "nope", prompt: "p" })).rejects.toThrow(NotFound);
    expect(() => store.getAssignment("a99")).toThrow(NotFound);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -w server -- store`
Expected: PASS (11 tests). If the "lists active first" test fails on ordering, the `createdAt` timestamps collided within the same millisecond — sort by id number as a tiebreak in `listAssignments`: replace the finished sort with `.sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))`.

- [ ] **Step 3: Commit**

```bash
git add server/test/store.test.ts server/src/store/store.ts
git commit -m "test(server): assignment persistence and listing"
```

---

### Task 5: Prompt assembler

**Files:**
- Create: `server/src/prompt/assemble.ts`, `server/test/assemble.test.ts`, `server/test/__snapshots__/` (generated)

**Interfaces:**
- Produces: `assemblePrompt(input: { memoryDir: string; index: string; task: string }): string`

- [ ] **Step 1: Failing test**

`server/test/assemble.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assemblePrompt } from "../src/prompt/assemble.js";

describe("assemblePrompt", () => {
  it("matches the spec §8.1 format with an index", () => {
    const out = assemblePrompt({ memoryDir: "/home/u/.agentgrid/agents/reviewer@hrns/memory",
      index: "- [Staging ns](staging-namespace.md) — namespace is hrns-stg\n", task: "Review PR #12" });
    expect(out).toMatchSnapshot();
    expect(out).toContain('<agent-memory dir="/home/u/.agentgrid/agents/reviewer@hrns/memory">');
    expect(out).toContain("<task>\nReview PR #12\n</task>");
  });
  it('uses "empty" when there is no index', () => {
    const out = assemblePrompt({ memoryDir: "/m", index: "   ", task: "t" });
    expect(out).toContain("<index>\nempty\n</index>");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- assemble`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/prompt/assemble.ts`:
```ts
export function assemblePrompt(input: { memoryDir: string; index: string; task: string }): string {
  const index = input.index.trim() || "empty";
  return [
    `<agent-memory dir="${input.memoryDir}">`,
    `<index>`, index, `</index>`,
    `Read a memory file with Read when its one-line hook looks relevant to the task.`,
    `Before you finish, save any durable, non-obvious fact about this repo, its`,
    `tooling, or this kind of task as a new file in the memory dir (frontmatter:`,
    `name, description) and add one line to MEMORY.md. Do not save what the repo`,
    `or git history already records.`,
    `</agent-memory>`,
    ``,
    `<task>`, input.task.trim(), `</task>`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests (writes the snapshot on first run)**

Run: `npm test -w server -- assemble`
Expected: PASS (2 tests), snapshot written.

- [ ] **Step 5: Commit**

```bash
git add server/src/prompt server/test/assemble.test.ts server/test/__snapshots__
git commit -m "feat(server): assignment prompt assembler with memory contract"
```

---

### Task 6: Fake query helper + Runner state machine

**Files:**
- Create: `server/test/helpers/fakeQuery.ts`, `server/src/runner/runner.ts`, `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 3/4), `assemblePrompt` (Task 5), types (Task 1).
- Produces:
  - `type QueryFn = (args: { prompt: string; options: RunnerOptions }) => AsyncIterable<SDKMessage>` where `RunnerOptions = Options` from the SDK.
  - `type BuildOptions = (role: RoleDef, agent: Agent, extra: { canUseTool: CanUseTool; abortController: AbortController }) => Options`
  - `class Runner { constructor(agentId: string, deps: { store: Store; queryFn: QueryFn; buildOptions: BuildOptions }); assign(prompt: string): Promise<Assignment>; answer(toolUseId: string, decision: Decision): Promise<void>; cancel(): Promise<void>; ack(): Promise<void>; readonly busy: boolean }`
  - Fake: `makeFakeQuery(): { queryFn: QueryFn; calls: Array<{ prompt: string; options: Options }>; emit(msg: SDKMessage): void; end(): void; fail(err: Error): void }`

- [ ] **Step 1: Fake query helper**

`server/test/helpers/fakeQuery.ts`:
```ts
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/runner.js";

export function makeFakeQuery() {
  const calls: Array<{ prompt: string; options: Options }> = [];
  const queue: Array<{ msg?: SDKMessage; end?: true; err?: Error }> = [];
  let wake: (() => void) | null = null;
  const push = (item: { msg?: SDKMessage; end?: true; err?: Error }) => { queue.push(item); wake?.(); wake = null; };

  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const signal = options.abortController?.signal;
    async function* gen(): AsyncGenerator<SDKMessage> {
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const item = queue.shift();
        if (!item) { await new Promise<void>(r => { wake = r; signal?.addEventListener("abort", () => r(), { once: true }); }); continue; }
        if (item.err) throw item.err;
        if (item.end) return;
        yield item.msg!;
      }
    }
    return gen();
  };
  return {
    queryFn, calls,
    emit: (msg: SDKMessage) => push({ msg }),
    end: () => push({ end: true }),
    fail: (err: Error) => push({ err }),
  };
}

// message factories (only the fields the runner reads)
export const init = (session_id: string) => ({ type: "system", subtype: "init", session_id } as unknown as SDKMessage);
export const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } } as unknown as SDKMessage);
export const toolUse = (name: string, input: Record<string, unknown>) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu", name, input }] } } as unknown as SDKMessage);
export const success = (result: string, cost = 0.5, turns = 3, session_id = "s1") =>
  ({ type: "result", subtype: "success", result, total_cost_usd: cost, num_turns: turns, duration_ms: 10, session_id, is_error: false } as unknown as SDKMessage);
export const errorResult = (subtype: string, cost = 0.1, turns = 1) =>
  ({ type: "result", subtype, total_cost_usd: cost, num_turns: turns, duration_ms: 10, is_error: true } as unknown as SDKMessage);
```

- [ ] **Step 2: Failing runner tests**

`server/test/runner.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, Conflict } from "../src/store/store.js";
import { Runner, type BuildOptions } from "../src/runner/runner.js";
import { makeFakeQuery, init, text, toolUse, success, errorResult } from "./helpers/fakeQuery.js";
import type { Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let store: Store; let fake: ReturnType<typeof makeFakeQuery>; let runner: Runner; let agentId: string;
let captured: { canUseTool?: CanUseTool } = {};

const buildOptions: BuildOptions = (role, agent, extra) => {
  captured.canUseTool = extra.canUseTool;
  return { cwd: agent.repo, model: role.model, abortController: extra.abortController, canUseTool: extra.canUseTool } as Options;
};

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  const a = await store.createAgent({ role: "coder", repo: "/tmp/repo" });
  agentId = a.id;
  fake = makeFakeQuery(); captured = {};
  runner = new Runner(agentId, { store, queryFn: fake.queryFn, buildOptions });
});

describe("Runner", () => {
  it("assign: builds prompt with memory index, marks agent working, records sessionId + activity", async () => {
    await writeFile(path.join(store.memoryDir(agentId), "MEMORY.md"), "- [k](k.md) — hook");
    const asg = await runner.assign("Fix the bug");
    expect(store.getAgent(agentId)).toMatchObject({ state: "working", currentAssignmentId: asg.id });
    expect(fake.calls[0].prompt).toContain("- [k](k.md) — hook");
    expect(fake.calls[0].prompt).toContain("<task>\nFix the bug\n</task>");
    expect(fake.calls[0].options.cwd).toBe("/tmp/repo");
    fake.emit(init("sess-1")); fake.emit(text("Looking at src/")); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ sessionId: "sess-1", activity: "Looking at src/", startedAt: expect.any(String) });
    fake.emit(toolUse("Bash", { command: "npm test" })); await tick();
    expect(store.getAssignment(asg.id).activity).toBe("Bash: npm test");
  });

  it("rejects assign when not free", async () => {
    await runner.assign("one");
    await expect(runner.assign("two")).rejects.toThrow(Conflict);
  });

  it("success result → done with outcome/cost/turns; ack → free", async () => {
    const asg = await runner.assign("t");
    fake.emit(success("DONE all good", 1.25, 7)); fake.end(); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "done", outcome: "DONE all good", costUsd: 1.25, turns: 7, endedAt: expect.any(String) });
    expect(store.getAgent(agentId).state).toBe("done");
    await runner.ack();
    expect(store.getAgent(agentId)).toMatchObject({ state: "free", currentAssignmentId: null });
  });

  it("error result → failed with error", async () => {
    const asg = await runner.assign("t");
    fake.emit(errorResult("error_max_turns")); fake.end(); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "error_max_turns" });
    expect(store.getAgent(agentId).state).toBe("failed");
  });

  it("thrown error → failed with message", async () => {
    const asg = await runner.assign("t");
    fake.fail(new Error("boom")); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "boom" });
  });

  it("permission: canUseTool parks → waiting with pending; allow resumes", async () => {
    const asg = await runner.assign("t");
    const p = captured.canUseTool!("Bash", { command: "rm x" }, { signal: new AbortController().signal, toolUseID: "tu-1", suggestions: [{ type: "addRules" }] } as any);
    await tick();
    expect(store.getAgent(agentId).state).toBe("waiting");
    expect(store.getAssignment(asg.id).pending).toEqual({ kind: "permission", toolUseId: "tu-1", toolName: "Bash", input: { command: "rm x" }, suggestions: [{ type: "addRules" }] });
    await runner.answer("tu-1", { kind: "allow" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(store.getAgent(agentId).state).toBe("working");
    expect(store.getAssignment(asg.id).pending).toBeNull();
  });

  it("permission: always → updatedPermissions; deny → deny message", async () => {
    await runner.assign("t");
    const p1 = captured.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-1", suggestions: [{ type: "addRules" }] } as any);
    await tick(); await runner.answer("tu-1", { kind: "always" });
    expect(await p1).toEqual({ behavior: "allow", updatedPermissions: [{ type: "addRules" }] });
    const p2 = captured.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-2" } as any);
    await tick(); await runner.answer("tu-2", { kind: "deny", message: "no" });
    expect(await p2).toEqual({ behavior: "deny", message: "no" });
  });

  it("question: AskUserQuestion → pending.kind question; answers → updatedInput", async () => {
    const asg = await runner.assign("t");
    const input = { questions: [{ question: "Which?", header: "H", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] };
    const p = captured.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "tu-q" } as any);
    await tick();
    expect(store.getAssignment(asg.id).pending?.kind).toBe("question");
    await runner.answer("tu-q", { kind: "answers", answers: { "Which?": "b" } });
    expect(await p).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which?": "b" } } });
  });

  it("answer with unknown toolUseId → Conflict", async () => {
    await runner.assign("t");
    await expect(runner.answer("nope", { kind: "allow" })).rejects.toThrow(Conflict);
  });

  it("cancel → failed(cancelled), keeps sessionId, aborts query", async () => {
    const asg = await runner.assign("t");
    fake.emit(init("sess-9")); await tick();
    await runner.cancel(); await tick();
    expect(fake.calls[0].options.abortController!.signal.aborted).toBe(true);
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "cancelled", sessionId: "sess-9" });
    expect(store.getAgent(agentId).state).toBe("failed");
  });

  it("cancel while waiting rejects the parked permission", async () => {
    await runner.assign("t");
    const p = captured.canUseTool!("Bash", { command: "x" }, { signal: new AbortController().signal, toolUseID: "tu-1" } as any);
    await tick(); await runner.cancel();
    expect(await p).toEqual({ behavior: "deny", message: "cancelled by user" });
  });

  it("ack when not done/failed → Conflict", async () => {
    await expect(runner.ack()).rejects.toThrow(Conflict);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w server -- runner`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement Runner**

`server/src/runner/runner.ts`:
```ts
import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Store, Conflict } from "../store/store.js";
import { assemblePrompt } from "../prompt/assemble.js";
import type { Agent, Assignment, Decision, Pending, RoleDef } from "../types.js";

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
export type BuildOptions = (role: RoleDef, agent: Agent, extra: { canUseTool: CanUseTool; abortController: AbortController }) => Options;

interface Parked { pending: Pending; resolve: (r: PermissionResult) => void }

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt ?? input.description ?? "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? `${name}: ${s.slice(0, 120)}` : name;
}

export class Runner {
  private parked = new Map<string, Parked>();
  private abort: AbortController | null = null;
  private assignmentId: string | null = null;

  constructor(readonly agentId: string, private deps: { store: Store; queryFn: QueryFn; buildOptions: BuildOptions }) {}

  get busy(): boolean { return this.assignmentId !== null; }

  async assign(prompt: string): Promise<Assignment> {
    const { store } = this.deps;
    const agent = store.getAgent(this.agentId);
    if (agent.state !== "free") throw new Conflict(`agent ${this.agentId} is ${agent.state}`);
    const role = store.getRole(agent.role);
    const assignment = await store.createAssignment({ agentId: this.agentId, prompt });
    this.assignmentId = assignment.id;
    await store.updateAgent(this.agentId, { state: "working", currentAssignmentId: assignment.id });

    const fullPrompt = assemblePrompt({ memoryDir: store.memoryDir(this.agentId), index: await store.readMemoryIndex(this.agentId), task: prompt });
    this.abort = new AbortController();
    const options = this.deps.buildOptions(role, agent, { canUseTool: this.canUseTool, abortController: this.abort });
    void this.consume(this.deps.queryFn({ prompt: fullPrompt, options }), assignment.id);
    return assignment;
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => {
    const toolUseId = opts.toolUseID;
    const pending: Pending = toolName === "AskUserQuestion"
      ? { kind: "question", toolUseId, toolName: "AskUserQuestion", input, suggestions: opts.suggestions ?? [] }
      : { kind: "permission", toolUseId, toolName, input, suggestions: opts.suggestions ?? [] };
    return new Promise<PermissionResult>(resolve => {
      this.parked.set(toolUseId, { pending, resolve });
      void this.patch({ pending, state: "waiting" }, "waiting");
    });
  };

  async answer(toolUseId: string, decision: Decision): Promise<void> {
    const parked = this.parked.get(toolUseId);
    if (!parked) throw new Conflict(`no pending prompt ${toolUseId} on ${this.agentId}`);
    this.parked.delete(toolUseId);
    const { pending } = parked;
    let result: PermissionResult;
    switch (decision.kind) {
      case "allow": result = { behavior: "allow" }; break;
      case "always": result = { behavior: "allow", updatedPermissions: pending.suggestions as PermissionResult extends { updatedPermissions?: infer U } ? U : never }; break;
      case "deny": result = { behavior: "deny", message: decision.message ?? "denied by user" }; break;
      case "answers": result = { behavior: "allow", updatedInput: { ...pending.input, answers: decision.answers, ...(decision.response ? { response: decision.response } : {}) } }; break;
    }
    await this.patch({ pending: null, state: "working" }, "working");
    parked.resolve(result);
  }

  async cancel(): Promise<void> {
    if (!this.assignmentId) throw new Conflict(`agent ${this.agentId} has no active assignment`);
    for (const [, p] of this.parked) p.resolve({ behavior: "deny", message: "cancelled by user" });
    this.parked.clear();
    this.abort?.abort();
    await this.finish({ state: "failed", error: "cancelled" });
  }

  async ack(): Promise<void> {
    const agent = this.deps.store.getAgent(this.agentId);
    if (agent.state !== "done" && agent.state !== "failed") throw new Conflict(`agent ${this.agentId} is ${agent.state}`);
    await this.deps.store.updateAgent(this.agentId, { state: "free", currentAssignmentId: null });
  }

  private async consume(stream: AsyncIterable<SDKMessage>, id: string): Promise<void> {
    try {
      for await (const m of stream) {
        if (this.assignmentId !== id) return; // cancelled meanwhile
        if (m.type === "system" && (m as any).subtype === "init") {
          await this.patch({ sessionId: (m as any).session_id, startedAt: new Date().toISOString() });
        } else if (m.type === "assistant") {
          const blocks = (m as any).message?.content ?? [];
          let activity: string | null = null;
          for (const b of blocks) {
            if (b.type === "text" && b.text?.trim()) activity = b.text.trim().slice(0, 160);
            if (b.type === "tool_use") activity = summarizeToolUse(b.name, b.input ?? {});
          }
          if (activity) await this.patch({ activity });
        } else if (m.type === "result") {
          const r = m as any;
          const common = { turns: r.num_turns ?? 0, costUsd: r.total_cost_usd ?? 0 };
          if (r.subtype === "success") await this.finish({ state: "done", outcome: r.result ?? "", ...common });
          else await this.finish({ state: "failed", error: r.subtype, ...common });
          return;
        }
      }
      if (this.assignmentId === id) await this.finish({ state: "failed", error: "stream ended without result" });
    } catch (err) {
      if (this.assignmentId === id) await this.finish({ state: "failed", error: (err as Error).message ?? String(err) });
    }
  }

  private async patch(patch: Partial<Assignment>, agentState?: Agent["state"]): Promise<void> {
    if (!this.assignmentId) return;
    await this.deps.store.updateAssignment(this.assignmentId, patch);
    if (agentState) await this.deps.store.updateAgent(this.agentId, { state: agentState });
  }

  private async finish(patch: Partial<Assignment> & { state: "done" | "failed" }): Promise<void> {
    const id = this.assignmentId; if (!id) return;
    this.assignmentId = null; this.abort = null;
    await this.deps.store.updateAssignment(id, { ...patch, pending: null, endedAt: new Date().toISOString() });
    await this.deps.store.updateAgent(this.agentId, { state: patch.state });
  }
}
```

If the `updatedPermissions` conditional type is rejected by tsc, replace it with `pending.suggestions as any`.

- [ ] **Step 5: Run tests**

Run: `npm test -w server -- runner`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/runner/runner.ts server/test/helpers server/test/runner.test.ts
git commit -m "feat(server): runner state machine around SDK query with parked permissions"
```

---

### Task 7: SDK options builder + Manager with restart recovery

**Files:**
- Create: `server/src/runner/sdk.ts`, `server/src/runner/manager.ts`, `server/test/manager.test.ts`, `server/test/sdk.test.ts`

**Interfaces:**
- Consumes: `Runner`, `QueryFn`, `BuildOptions` (Task 6).
- Produces:
  - `buildOptions: BuildOptions` and `realQuery: QueryFn` (wraps SDK `query`).
  - `class Manager { constructor(store: Store, deps?: { queryFn?: QueryFn; buildOptions?: BuildOptions }); recoverOnStart(): Promise<void>; assign(agentId, prompt): Promise<Assignment>; answer(agentId, toolUseId, decision): Promise<void>; cancel(agentId): Promise<void>; ack(agentId): Promise<void>; archive(agentId): Promise<void> }`

- [ ] **Step 1: Failing tests**

`server/test/sdk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildOptions } from "../src/runner/sdk.js";
import type { RoleDef, Agent } from "../src/types.js";

const role: RoleDef = { name: "reviewer", avatar: "x", model: "claude-opus-5", effort: "high", permissionMode: "default",
  settingSources: ["user"], allowedTools: ["Read"], maxTurns: 40, maxBudgetUsd: 3, prompt: "You review." };
const agent: Agent = { id: "reviewer@r", role: "reviewer", repo: "/r", displayName: "R", createdAt: "", state: "free", currentAssignmentId: null };

describe("buildOptions", () => {
  it("maps role + agent to SDK options", () => {
    const ac = new AbortController(); const canUseTool = async () => ({ behavior: "allow" as const });
    const o = buildOptions(role, agent, { canUseTool, abortController: ac });
    expect(o).toMatchObject({
      cwd: "/r", model: "claude-opus-5", effort: "high", permissionMode: "default", settingSources: ["user"],
      allowedTools: ["Read"], maxTurns: 40, maxBudgetUsd: 3, permissionPrompts: "host", agent: "reviewer",
      agents: { reviewer: { description: "AgentGrid role reviewer", prompt: "You review.", model: "claude-opus-5" } },
    });
    expect(o.abortController).toBe(ac);
    expect(o.canUseTool).toBe(canUseTool);
  });
});
```

`server/test/manager.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, NotFound } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { makeFakeQuery, success } from "./helpers/fakeQuery.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let home: string; let store: Store; let fake: ReturnType<typeof makeFakeQuery>; let mgr: Manager;
const buildOptions = (_r: any, a: any, e: any) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  fake = makeFakeQuery();
  mgr = new Manager(store, { queryFn: fake.queryFn, buildOptions });
});

describe("Manager", () => {
  it("routes assign/ack to a per-agent runner", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await mgr.assign(a.id, "p");
    fake.emit(success("ok")); fake.end(); await tick();
    expect(store.getAssignment(asg.id).state).toBe("done");
    await mgr.ack(a.id);
    expect(store.getAgent(a.id).state).toBe("free");
  });

  it("unknown agent → NotFound", async () => {
    await expect(mgr.assign("ghost", "p")).rejects.toThrow(NotFound);
  });

  it("recoverOnStart fails in-flight assignments and frees agents", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await store.createAssignment({ agentId: a.id, prompt: "p" });
    await store.updateAssignment(asg.id, { state: "waiting", sessionId: "s-keep" });
    await store.updateAgent(a.id, { state: "waiting", currentAssignmentId: asg.id });
    const s2 = new Store(home, path.resolve("roles")); await s2.init();
    const m2 = new Manager(s2, { queryFn: fake.queryFn, buildOptions });
    await m2.recoverOnStart();
    expect(s2.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "server restarted", sessionId: "s-keep", pending: null });
    expect(s2.getAgent(a.id)).toMatchObject({ state: "free", currentAssignmentId: null });
  });

  it("archive cancels a running assignment first", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await mgr.assign(a.id, "p");
    await mgr.archive(a.id); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "cancelled" });
    expect(() => store.getAgent(a.id)).toThrow(NotFound);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- manager sdk`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement sdk.ts and manager.ts**

`server/src/runner/sdk.ts`:
```ts
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { BuildOptions, QueryFn } from "./runner.js";

export const realQuery: QueryFn = ({ prompt, options }) => query({ prompt, options });

export const buildOptions: BuildOptions = (role, agent, extra) => {
  const o: Options = {
    cwd: agent.repo,
    model: role.model,
    effort: role.effort,
    permissionMode: role.permissionMode,
    settingSources: role.settingSources,
    allowedTools: role.allowedTools,
    maxTurns: role.maxTurns,
    permissionPrompts: "host",
    agent: role.name,
    agents: { [role.name]: { description: `AgentGrid role ${role.name}`, prompt: role.prompt, model: role.model } },
    canUseTool: extra.canUseTool,
    abortController: extra.abortController,
  };
  if (role.maxBudgetUsd !== undefined) o.maxBudgetUsd = role.maxBudgetUsd;
  return o;
};
```

`server/src/runner/manager.ts`:
```ts
import { Store } from "../store/store.js";
import { Runner, type BuildOptions, type QueryFn } from "./runner.js";
import { buildOptions as defaultBuildOptions, realQuery } from "./sdk.js";
import type { Assignment, Decision } from "../types.js";

export class Manager {
  private runners = new Map<string, Runner>();
  private queryFn: QueryFn; private buildOptions: BuildOptions;

  constructor(private store: Store, deps: { queryFn?: QueryFn; buildOptions?: BuildOptions } = {}) {
    this.queryFn = deps.queryFn ?? realQuery;
    this.buildOptions = deps.buildOptions ?? defaultBuildOptions;
  }

  private runner(agentId: string): Runner {
    this.store.getAgent(agentId); // throws NotFound
    let r = this.runners.get(agentId);
    if (!r) { r = new Runner(agentId, { store: this.store, queryFn: this.queryFn, buildOptions: this.buildOptions }); this.runners.set(agentId, r); }
    return r;
  }

  async recoverOnStart(): Promise<void> {
    for (const a of this.store.listAssignments(Number.MAX_SAFE_INTEGER)) {
      if (a.state === "working" || a.state === "waiting") {
        await this.store.updateAssignment(a.id, { state: "failed", error: "server restarted", pending: null, endedAt: new Date().toISOString() });
      }
    }
    for (const ag of this.store.listAgents()) {
      if (ag.state !== "free") await this.store.updateAgent(ag.id, { state: "free", currentAssignmentId: null });
    }
  }

  assign(agentId: string, prompt: string): Promise<Assignment> { return this.runner(agentId).assign(prompt); }
  answer(agentId: string, toolUseId: string, decision: Decision): Promise<void> { return this.runner(agentId).answer(toolUseId, decision); }
  cancel(agentId: string): Promise<void> { return this.runner(agentId).cancel(); }
  ack(agentId: string): Promise<void> { return this.runner(agentId).ack(); }

  async archive(agentId: string): Promise<void> {
    const r = this.runner(agentId);
    if (r.busy) await r.cancel();
    this.runners.delete(agentId);
    await this.store.archiveAgent(agentId);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- manager sdk`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/runner server/test/manager.test.ts server/test/sdk.test.ts
git commit -m "feat(server): SDK option builder and runner manager with restart recovery"
```

---

### Task 8: HTTP API (REST)

**Files:**
- Create: `server/src/api/app.ts`, `server/test/api.test.ts`

**Interfaces:**
- Consumes: `Store`, `Manager`.
- Produces: `createApp(deps: { store: Store; manager: Manager; transcript?: (a: Assignment, agent: Agent) => Promise<unknown[]>; openTerminal?: (repo: string, sessionId: string) => Promise<void>; staticDir?: string }): express.Express`. Routes exactly as spec §6.3 (SSE added in Task 9, transcript/terminal wired in Task 10).

- [ ] **Step 1: Failing tests**

`server/test/api.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { createApp } from "../src/api/app.js";
import { makeFakeQuery, success } from "./helpers/fakeQuery.js";
import type { Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let app: ReturnType<typeof createApp>; let store: Store; let fake: ReturnType<typeof makeFakeQuery>;
let canUseTool: CanUseTool | undefined;

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  fake = makeFakeQuery();
  const manager = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => { canUseTool = e.canUseTool; return { cwd: a.repo, abortController: e.abortController } as Options; } });
  app = createApp({ store, manager });
});

describe("API", () => {
  it("GET /api/state returns roles, agents, assignments", async () => {
    const res = await request(app).get("/api/state").expect(200);
    expect(res.body.roles.map((r: any) => r.name)).toContain("coder");
    expect(res.body.agents).toEqual([]);
    expect(res.body.assignments).toEqual([]);
  });

  it("POST /api/agents validates and creates; DELETE archives", async () => {
    await request(app).post("/api/agents").send({ role: "coder" }).expect(400);
    await request(app).post("/api/agents").send({ role: "nope", repo: "/x" }).expect(404);
    const res = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns", displayName: "Cody" }).expect(201);
    expect(res.body).toMatchObject({ id: "coder@hrns", displayName: "Cody", state: "free" });
    await request(app).delete("/api/agents/coder@hrns").expect(204);
    await request(app).get("/api/agents/coder@hrns/memory").expect(404);
  });

  it("assign → answer → ack flow with proper status codes", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    await request(app).post(`/api/agents/${agent.id}/assign`).send({}).expect(400);
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" }).expect(201);
    expect(asg.state).toBe("working");
    await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "again" }).expect(409);

    const p = canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-1" } as any);
    await tick();
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("waiting");
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "zzz", decision: { kind: "allow" } }).expect(409);
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "tu-1", decision: { kind: "allow" } }).expect(204);
    expect(await p).toEqual({ behavior: "allow" });

    await request(app).post(`/api/agents/${agent.id}/ack`).expect(409);
    fake.emit(success("fin")); fake.end(); await tick();
    await request(app).post(`/api/agents/${agent.id}/ack`).expect(204);
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("free");
  });

  it("cancel → 204 and failed", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" });
    await request(app).post(`/api/agents/${agent.id}/cancel`).expect(204);
    await tick();
    expect((await request(app).get("/api/state")).body.assignments.find((a: any) => a.id === asg.id).state).toBe("failed");
    await request(app).post(`/api/agents/${agent.id}/cancel`).expect(409);
  });

  it("GET memory lists files; unknown ids are 404", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    expect((await request(app).get(`/api/agents/${agent.id}/memory`).expect(200)).body).toEqual([]);
    await request(app).get("/api/assignments/a99/transcript").expect(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- api`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the app**

`server/src/api/app.ts`:
```ts
import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { Store } from "../store/store.js";
import { Manager } from "../runner/manager.js";
import { sseHandler } from "./sse.js";
import type { Agent, Assignment, Decision } from "../types.js";

export interface AppDeps {
  store: Store;
  manager: Manager;
  transcript?: (assignment: Assignment, agent: Agent) => Promise<unknown[]>;
  openTerminal?: (repo: string, sessionId: string) => Promise<void>;
  staticDir?: string;
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
    const command = `cd ${JSON.stringify(agent.repo)} && claude --resume ${asg.sessionId}`;
    if (deps.openTerminal) await deps.openTerminal(agent.repo, asg.sessionId);
    res.json({ command, opened: Boolean(deps.openTerminal) });
  }));
  app.get("/api/assignments/:id/transcript", wrap(async (req, res) => {
    const asg = store.getAssignment(req.params.id as string);
    const agent = store.getAgent(asg.agentId);
    res.json(deps.transcript ? await deps.transcript(asg, agent) : []);
  }));

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
```

Create a stub `server/src/api/sse.ts` for now (replaced in Task 9):
```ts
import type { Request, Response } from "express";
import type { Store } from "../store/store.js";
export const sseHandler = (_store: Store) => (_req: Request, res: Response) => { res.status(501).end(); };
```

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- api`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/api server/test/api.test.ts
git commit -m "feat(server): REST API for agents, assignments, answers and memory"
```

---

### Task 9: SSE events endpoint

**Files:**
- Modify: `server/src/api/sse.ts` (replace stub)
- Create: `server/test/sse.test.ts`

**Interfaces:**
- Produces: `GET /api/events` — `text/event-stream`; first frame is `event: snapshot` with the full `GridState`, then one `event: change` per `GridEvent`, plus a `: ping` comment every 25 s.

- [ ] **Step 1: Failing test**

`server/test/sse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { createApp } from "../src/api/app.js";
import { makeFakeQuery } from "./helpers/fakeQuery.js";

describe("SSE", () => {
  it("sends a snapshot then change events", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-"));
    const store = new Store(home, path.resolve("roles")); await store.init();
    const app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }) });
    const server = http.createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;

    const chunks: string[] = [];
    const res = await new Promise<http.IncomingMessage>(r => http.get(`http://127.0.0.1:${port}/api/events`, r));
    expect(res.headers["content-type"]).toContain("text/event-stream");
    res.setEncoding("utf8"); res.on("data", c => chunks.push(c));

    await new Promise(r => setTimeout(r, 30));
    await store.createAgent({ role: "coder", repo: "/x/hrns" });
    await new Promise(r => setTimeout(r, 30));

    const text = chunks.join("");
    expect(text).toMatch(/^event: snapshot\ndata: \{"roles"/);
    expect(text).toContain('event: change\ndata: {"type":"agent","agent":{"id":"coder@hrns"');
    res.destroy(); server.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- sse`
Expected: FAIL — content-type is not text/event-stream (stub returns 501).

- [ ] **Step 3: Implement**

`server/src/api/sse.ts`:
```ts
import type { Request, Response } from "express";
import type { Store } from "../store/store.js";
import type { GridEvent } from "../types.js";

export const sseHandler = (store: Store) => (req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("snapshot", store.getState());
  const onEvent = (e: GridEvent) => send("change", e);
  store.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); store.off("event", onEvent); });
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -w server`
Expected: all server tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/sse.ts server/test/sse.test.ts
git commit -m "feat(server): SSE stream of grid state changes"
```

---

### Task 10: Transcript parser + terminal opener

**Files:**
- Create: `server/src/transcript.ts`, `server/src/terminal.ts`, `server/test/transcript.test.ts`

**Interfaces:**
- Produces:
  - `encodeProjectDir(cwd: string): string` — Claude Code's encoding: every char not `[A-Za-z0-9]` becomes `-`.
  - `transcriptPath(cwd: string, sessionId: string, claudeHome?: string): string`
  - `readTranscript(cwd, sessionId, claudeHome?): Promise<TranscriptEntry[]>` where `TranscriptEntry = { ts: string; role: "user" | "assistant"; kind: "text" | "tool_use" | "tool_result"; text: string }` — last 200 entries.
  - `openTerminal(repo: string, sessionId: string): Promise<void>` — macOS only, iTerm if installed else Terminal.app.

- [ ] **Step 1: Failing tests**

`server/test/transcript.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeProjectDir, transcriptPath, readTranscript } from "../src/transcript.js";

describe("transcript", () => {
  it("encodes cwd like Claude Code", () => {
    expect(encodeProjectDir("/Users/m/MinsterMind/hrns")).toBe("-Users-m-MinsterMind-hrns");
    expect(encodeProjectDir("/a/b.c_d e")).toBe("-a-b-c-d-e");
  });
  it("builds the path under claude home", () => {
    expect(transcriptPath("/x/y", "s1", "/home/u/.claude")).toBe("/home/u/.claude/projects/-x-y/s1.jsonl");
  });
  it("parses text, tool_use and tool_result lines and ignores others", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ch-"));
    const dir = path.join(home, "projects", "-x-y"); await mkdir(dir, { recursive: true });
    const lines = [
      { type: "user", timestamp: "t1", message: { role: "user", content: "do it" } },
      { type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", timestamp: "t3", message: { role: "user", content: [{ type: "tool_result", content: "a.txt" }] } },
      { type: "summary", summary: "x" },
    ].map(l => JSON.stringify(l)).join("\n");
    await writeFile(path.join(dir, "s1.jsonl"), lines);
    expect(await readTranscript("/x/y", "s1", home)).toEqual([
      { ts: "t1", role: "user", kind: "text", text: "do it" },
      { ts: "t2", role: "assistant", kind: "text", text: "ok" },
      { ts: "t2", role: "assistant", kind: "tool_use", text: "Bash: ls" },
      { ts: "t3", role: "user", kind: "tool_result", text: "a.txt" },
    ]);
  });
  it("returns [] when the file is missing", async () => {
    expect(await readTranscript("/nope", "s", "/nope")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- transcript`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/transcript.ts`:
```ts
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TranscriptEntry { ts: string; role: "user" | "assistant"; kind: "text" | "tool_use" | "tool_result"; text: string }

export const encodeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export function transcriptPath(cwd: string, sessionId: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  return path.join(claudeHome, "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

const str = (c: unknown): string => typeof c === "string" ? c
  : Array.isArray(c) ? c.map(b => (b?.type === "text" ? b.text : typeof b === "string" ? b : "")).join("") : "";

export async function readTranscript(cwd: string, sessionId: string, claudeHome?: string): Promise<TranscriptEntry[]> {
  const raw = await readFile(transcriptPath(cwd, sessionId, claudeHome), "utf8").catch(() => "");
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const role = e.type as "user" | "assistant"; const ts = e.timestamp ?? "";
    const content = e.message?.content;
    if (typeof content === "string") { out.push({ ts, role, kind: "text", text: content }); continue; }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === "text" && b.text?.trim()) out.push({ ts, role, kind: "text", text: b.text });
      else if (b.type === "tool_use") {
        const v = b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? "";
        out.push({ ts, role, kind: "tool_use", text: v ? `${b.name}: ${String(v).slice(0, 200)}` : b.name });
      } else if (b.type === "tool_result") out.push({ ts, role, kind: "tool_result", text: str(b.content).slice(0, 500) });
    }
  }
  return out.slice(-200);
}
```

`server/src/terminal.ts`:
```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, err => (err ? rej(err) : res())));

export async function openTerminal(repo: string, sessionId: string): Promise<void> {
  if (process.platform !== "darwin") throw Object.assign(new Error("open-terminal is macOS only"), { status: 501 });
  const shell = `cd ${JSON.stringify(repo)} && claude --resume ${sessionId}`;
  const esc = shell.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const hasITerm = await access("/Applications/iTerm.app").then(() => true, () => false);
  const script = hasITerm
    ? `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text "${esc}"\nend tell`
    : `tell application "Terminal"\nactivate\ndo script "${esc}"\nend tell`;
  await run("osascript", ["-e", script]);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w server -- transcript`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/transcript.ts server/src/terminal.ts server/test/transcript.test.ts
git commit -m "feat(server): session transcript reader and macOS terminal opener"
```

---

### Task 11: Server entry point + live integration test

**Files:**
- Create: `server/src/index.ts`, `server/test/live.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `agentgrid serve` (`npm run serve -w server`) on `127.0.0.1:4800`, serving `ui/dist` when present. `AGENTGRID_FAKE=1` swaps in a scripted runner (used by the UI e2e test in Task 17).

- [ ] **Step 1: Entry point**

`server/src/index.ts`:
```ts
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
  if (r.behavior === "deny") { yield { type: "result", subtype: "error_during_execution", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, is_error: true } as any; return; }
  yield { type: "result", subtype: "success", result: "All done (fake).", num_turns: 2, total_cost_usd: 0.02, duration_ms: 1, is_error: false } as any;
})();

async function serve() {
  const store = new Store(resolveHome(), defaultsDir);
  await store.init();
  const manager = new Manager(store, process.env.AGENTGRID_FAKE ? { queryFn: fakeQuery, buildOptions: (_r, a, e) => ({ cwd: a.repo, canUseTool: e.canUseTool, abortController: e.abortController }) } : {});
  await manager.recoverOnStart();
  watch(store.rolesDir, () => void store.reloadRoles().catch(err => console.error("roles reload failed:", err.message)));
  const app = createApp({ store, manager, transcript: (asg, agent) => readTranscript(agent.repo, asg.sessionId ?? ""), openTerminal, staticDir: uiDist });
  const port = Number(process.env.AGENTGRID_PORT ?? 4800);
  http.createServer(app).listen(port, "127.0.0.1", () => console.log(`AgentGrid on http://127.0.0.1:${port}  (data: ${resolveHome()}${uiDist ? "" : ", UI not built"})`));
}

const cmd = process.argv[2];
if (cmd === "serve") serve().catch(err => { console.error(err); process.exit(1); });
else { console.log("usage: agentgrid serve"); process.exit(cmd ? 1 : 0); }
```

- [ ] **Step 2: Manual check**

Run: `npm run serve -w server` then in another shell `curl -s localhost:4800/api/state | head -c 200`
Expected: JSON with the six default roles; `~/.agentgrid/roles/` populated. Stop the server.

- [ ] **Step 3: Live integration test (opt-in, real SDK, costs cents)**

`server/test/live.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";

const live = process.env.AGENTGRID_LIVE === "1";
const until = async (pred: () => boolean, ms = 120_000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 200)); } };

describe.skipIf(!live)("live SDK", () => {
  it("permission + question + memory + resume", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-live-"));
    const repo = await mkdtemp(path.join(tmpdir(), "ag-repo-")); await writeFile(path.join(repo, "README.md"), "# t");
    const store = new Store(home, path.resolve("roles")); await store.init();
    await writeFile(path.join(home, "roles", "spike.md"), `---\nname: spike\nmodel: claude-opus-5\neffort: low\npermissionMode: default\nsettingSources: []\nmaxTurns: 10\n---\nYou are a test agent. Follow instructions literally.`);
    await store.reloadRoles();
    const agent = await store.createAgent({ role: "spike", repo });
    const mgr = new Manager(store);
    const asg = await mgr.assign(agent.id, `1. Call AskUserQuestion with one question "Which greeting?" options "hello" and "namaste".\n2. Using Bash run: echo "<answer>" > greeting.txt\n3. Save a memory file about which greeting this repo uses.\n4. Reply: DONE <greeting>.`);

    await until(() => store.getAssignment(asg.id).pending?.kind === "question");
    const q = store.getAssignment(asg.id).pending!;
    await mgr.answer(agent.id, q.toolUseId, { kind: "answers", answers: { [(q.input as any).questions[0].question]: "namaste" } });
    await until(() => store.getAssignment(asg.id).pending?.kind === "permission");
    await mgr.answer(agent.id, store.getAssignment(asg.id).pending!.toolUseId, { kind: "allow" });
    // memory write may also prompt (Write tool) — allow anything further
    await until(() => { const a = store.getAssignment(asg.id); if (a.pending) void mgr.answer(agent.id, a.pending.toolUseId, { kind: "allow" }); return a.state === "done" || a.state === "failed"; });

    const done = store.getAssignment(asg.id);
    expect(done.state).toBe("done");
    expect(done.outcome).toMatch(/namaste/i);
    expect(await readFile(path.join(repo, "greeting.txt"), "utf8")).toMatch(/namaste/);
    expect((await readdir(store.memoryDir(agent.id))).some(f => f.endsWith(".md"))).toBe(true);

    const reply = await new Promise<string>((res, rej) => execFile("claude", ["--resume", done.sessionId!, "-p", "One line: what greeting did you write?"], { cwd: repo }, (e, out) => (e ? rej(e) : res(out))));
    expect(reply).toMatch(/namaste/i);
  }, 300_000);
});
```

- [ ] **Step 4: Run it once**

Run: `npm run test:live -w server`
Expected: PASS (~1–3 minutes, a few cents). Without `AGENTGRID_LIVE=1` the suite is skipped.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/test/live.test.ts
git commit -m "feat(server): serve command, fake runner mode and opt-in live SDK test"
```

---

### Task 12: UI scaffold, state reducer and API client

**Files:**
- Create: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/App.tsx` (placeholder), `ui/src/types.ts`, `ui/src/state/reducer.ts`, `ui/src/api.ts`, `ui/test/reducer.test.ts`, `ui/test/setup.ts`

**Interfaces:**
- Produces:
  - `ui/src/types.ts` re-exports the server's domain types via a relative import: `export type * from "../../server/src/types.js"`.
  - `reducer(state: UiState, action: Action): UiState` with `UiState = { roles; agents; assignments: Record<string, Assignment>; selectedId: string | null; connected: boolean }` and actions `{type:"snapshot"; state: GridState} | {type:"change"; event: GridEvent} | {type:"select"; id: string|null} | {type:"connected"; value: boolean}`.
  - Selectors: `assignmentFor(state, agent): Assignment | null`, `counts(state): Record<AgentState, number>`, `todaySpend(state): number`, `waitingIds(state): string[]`.
  - `api`: `getState()`, `subscribe(onSnapshot, onChange, onConnected): () => void`, `createAgent(input)`, `deleteAgent(id)`, `assign(id, prompt)`, `answer(id, toolUseId, decision)`, `cancel(id)`, `ack(id)`, `openTerminal(id): Promise<{command: string; opened: boolean}>`, `memory(id)`, `transcript(assignmentId)`.

- [ ] **Step 1: Package files**

`ui/package.json`:
```json
{
  "name": "@agentgrid/ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },
  "devDependencies": {
    "@playwright/test": "^1.52.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.4.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.8.0",
    "vite": "^6.3.0",
    "vitest": "^3.1.0"
  }
}
```

`ui/vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4800" } },
  test: { environment: "jsdom", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], setupFiles: ["test/setup.ts"] },
});
```

`ui/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx", "lib": ["ES2022", "DOM"], "types": ["vite/client", "@testing-library/jest-dom"], "noEmit": true },
  "include": ["src", "test", "../server/src/types.ts"] }
```

`ui/index.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentGrid</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

`ui/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
```

`ui/src/App.tsx` (placeholder, replaced in Task 16):
```tsx
export function App() { return <div>AgentGrid</div>; }
```

`ui/src/styles.css` (placeholder, filled in Task 16): empty file.

`ui/src/types.ts`:
```ts
export type * from "../../server/src/types.js";
```

`ui/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Failing reducer test**

`ui/test/reducer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds } from "../src/state/reducer";
import type { Agent, Assignment } from "../src/types";

const agent = (id: string, state: Agent["state"] = "free", cur: string | null = null): Agent =>
  ({ id, role: "coder", repo: "/r/" + id, displayName: id, createdAt: "2026-09-11T00:00:00Z", state, currentAssignmentId: cur });
const asg = (id: string, agentId: string, extra: Partial<Assignment> = {}): Assignment =>
  ({ id, agentId, prompt: "p", createdAt: new Date().toISOString(), startedAt: null, endedAt: null, sessionId: null,
     state: "working", activity: "", pending: null, outcome: null, error: null, turns: 0, costUsd: 0, ...extra });

describe("reducer", () => {
  it("snapshot replaces state, keeps selection", () => {
    const s = reducer({ ...initial, selectedId: "a" }, { type: "snapshot", state: { roles: [], agents: [agent("a")], assignments: [asg("a1", "a")] } });
    expect(s.agents.map(a => a.id)).toEqual(["a"]);
    expect(s.assignments.a1.id).toBe("a1");
    expect(s.selectedId).toBe("a");
  });
  it("change: agent upsert preserves order; removal clears selection", () => {
    let s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [agent("a"), agent("b")], assignments: [] } });
    s = reducer(s, { type: "change", event: { type: "agent", agent: agent("a", "working", "a1") } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "b"]);
    expect(s.agents[0].state).toBe("working");
    s = reducer(s, { type: "change", event: { type: "agent", agent: agent("c") } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "b", "c"]);
    s = reducer({ ...s, selectedId: "b" }, { type: "change", event: { type: "agent-removed", id: "b" } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "c"]);
    expect(s.selectedId).toBeNull();
  });
  it("selectors", () => {
    const a = agent("a", "waiting", "a1"), b = agent("b", "done", "a2"), c = agent("c");
    const s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [a, b, c],
      assignments: [asg("a1", "a", { state: "waiting", costUsd: 0.5 }), asg("a2", "b", { state: "done", costUsd: 1.5 }), asg("a0", "b", { state: "done", costUsd: 9, createdAt: "2020-01-01T00:00:00Z" })] } });
    expect(assignmentFor(s, a)?.id).toBe("a1");
    expect(assignmentFor(s, c)).toBeNull();
    expect(counts(s)).toEqual({ free: 1, working: 0, waiting: 1, done: 1, failed: 0 });
    expect(todaySpend(s)).toBe(2);
    expect(waitingIds(s)).toEqual(["a"]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm install && npm test -w ui`
Expected: FAIL — module `../src/state/reducer` not found.

- [ ] **Step 4: Implement reducer and api**

`ui/src/state/reducer.ts`:
```ts
import type { Agent, AgentState, Assignment, GridEvent, GridState, RoleDef } from "../types";

export interface UiState { roles: RoleDef[]; agents: Agent[]; assignments: Record<string, Assignment>; selectedId: string | null; connected: boolean }
export type Action =
  | { type: "snapshot"; state: GridState }
  | { type: "change"; event: GridEvent }
  | { type: "select"; id: string | null }
  | { type: "connected"; value: boolean };

export const initial: UiState = { roles: [], agents: [], assignments: {}, selectedId: null, connected: false };

export function reducer(s: UiState, a: Action): UiState {
  switch (a.type) {
    case "snapshot":
      return { ...s, roles: a.state.roles, agents: a.state.agents,
        assignments: Object.fromEntries(a.state.assignments.map(x => [x.id, x])),
        selectedId: a.state.agents.some(x => x.id === s.selectedId) ? s.selectedId : null };
    case "change": {
      const e = a.event;
      if (e.type === "roles") return { ...s, roles: e.roles };
      if (e.type === "assignment") return { ...s, assignments: { ...s.assignments, [e.assignment.id]: e.assignment } };
      if (e.type === "agent-removed") return { ...s, agents: s.agents.filter(x => x.id !== e.id), selectedId: s.selectedId === e.id ? null : s.selectedId };
      const i = s.agents.findIndex(x => x.id === e.agent.id);
      const agents = i === -1 ? [...s.agents, e.agent] : s.agents.map((x, j) => (j === i ? e.agent : x));
      return { ...s, agents };
    }
    case "select": return { ...s, selectedId: a.id };
    case "connected": return { ...s, connected: a.value };
  }
}

export const assignmentFor = (s: UiState, agent: Agent): Assignment | null =>
  agent.currentAssignmentId ? s.assignments[agent.currentAssignmentId] ?? null : null;

export const counts = (s: UiState): Record<AgentState, number> => {
  const c: Record<AgentState, number> = { free: 0, working: 0, waiting: 0, done: 0, failed: 0 };
  for (const a of s.agents) c[a.state]++;
  return c;
};

export const todaySpend = (s: UiState): number => {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(s.assignments).filter(a => a.createdAt.slice(0, 10) === today).reduce((n, a) => n + a.costUsd, 0);
};

export const waitingIds = (s: UiState): string[] => s.agents.filter(a => a.state === "waiting").map(a => a.id);
```

`ui/src/api.ts`:
```ts
import type { Agent, Assignment, Decision, GridEvent, GridState, MemoryFile } from "./types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  getState: () => call<GridState>("GET", "/api/state"),
  subscribe(onSnapshot: (s: GridState) => void, onChange: (e: GridEvent) => void, onConnected: (v: boolean) => void): () => void {
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", ev => { onConnected(true); onSnapshot(JSON.parse((ev as MessageEvent).data)); });
    es.addEventListener("change", ev => onChange(JSON.parse((ev as MessageEvent).data)));
    es.onerror = () => onConnected(false);
    return () => es.close();
  },
  createAgent: (input: { role: string; repo: string; displayName?: string }) => call<Agent>("POST", "/api/agents", input),
  deleteAgent: (id: string) => call<void>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
  assign: (id: string, prompt: string) => call<Assignment>("POST", `/api/agents/${encodeURIComponent(id)}/assign`, { prompt }),
  answer: (id: string, toolUseId: string, decision: Decision) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/answer`, { toolUseId, decision }),
  cancel: (id: string) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/cancel`),
  ack: (id: string) => call<void>("POST", `/api/agents/${encodeURIComponent(id)}/ack`),
  openTerminal: (id: string) => call<{ command: string; opened: boolean }>("POST", `/api/agents/${encodeURIComponent(id)}/open-terminal`),
  memory: (id: string) => call<MemoryFile[]>("GET", `/api/agents/${encodeURIComponent(id)}/memory`),
  transcript: (assignmentId: string) => call<Array<{ ts: string; role: string; kind: string; text: string }>>("GET", `/api/assignments/${assignmentId}/transcript`),
};
```

- [ ] **Step 5: Run tests**

Run: `npm test -w ui`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add ui
git commit -m "feat(ui): scaffold Vite/React app with state reducer and API client"
```

---

### Task 13: AgentTile, AssignBox and AgentGrid

**Files:**
- Create: `ui/src/components/AgentTile.tsx`, `ui/src/components/AssignBox.tsx`, `ui/src/components/AgentGrid.tsx`, `ui/src/format.ts`, `ui/test/AgentTile.test.tsx`

**Interfaces:**
- Produces:
  - `<AgentTile agent role assignment selected index onSelect(id) onAssign(id, prompt) />` — `data-state={agent.state}`, `data-testid="tile-<id>"`.
  - `<AssignBox agentId recent onSubmit(prompt) />` — textarea; `Enter` submits, `Shift+Enter` newline, `/` at empty opens recent list.
  - `<AgentGrid agents roles assignments selectedId onSelect onAssign />`.
  - `format.ts`: `elapsed(fromIso: string | null, now?: number): string` (e.g. `6m`, `1h 12m`), `usd(n): string` (`$0.31`).

- [ ] **Step 1: Failing tests**

`ui/test/AgentTile.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTile } from "../src/components/AgentTile";
import { elapsed, usd } from "../src/format";
import type { Agent, Assignment, RoleDef } from "../src/types";

const role: RoleDef = { name: "devops", avatar: "🛠️", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" };
const agent = (state: Agent["state"], cur: string | null = "a41"): Agent =>
  ({ id: "devops@hrns", role: "devops", repo: "/u/MinsterMind/hrns", displayName: "Dev", createdAt: "", state, currentAssignmentId: cur });
const asg = (extra: Partial<Assignment>): Assignment =>
  ({ id: "a41", agentId: "devops@hrns", prompt: "restart", createdAt: "", startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), endedAt: null,
     sessionId: null, state: "working", activity: "Bash: kubectl get pods", pending: null, outcome: null, error: null, turns: 3, costUsd: 0.31, ...extra });
const base = { role, index: 0, selected: false, onSelect: vi.fn(), onAssign: vi.fn() };

describe("format", () => {
  it("elapsed and usd", () => {
    const now = Date.parse("2026-09-11T10:00:00Z");
    expect(elapsed("2026-09-11T09:54:00Z", now)).toBe("6m");
    expect(elapsed("2026-09-11T08:48:00Z", now)).toBe("1h 12m");
    expect(elapsed(null, now)).toBe("—");
    expect(usd(0.31)).toBe("$0.31");
  });
});

describe("AgentTile", () => {
  it("renders persona, repo basename, activity and footer for a working agent", () => {
    render(<AgentTile {...base} agent={agent("working")} assignment={asg({})} />);
    const tile = screen.getByTestId("tile-devops@hrns");
    expect(tile).toHaveAttribute("data-state", "working");
    expect(tile).toHaveTextContent("🛠️"); expect(tile).toHaveTextContent("Dev"); expect(tile).toHaveTextContent("devops"); expect(tile).toHaveTextContent("hrns");
    expect(tile).toHaveTextContent("Bash: kubectl get pods");
    expect(tile).toHaveTextContent("#a41"); expect(tile).toHaveTextContent("$0.31");
  });
  it("waiting shows a badge with the pending kind", () => {
    render(<AgentTile {...base} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: { kind: "question", toolUseId: "t", toolName: "AskUserQuestion", input: {}, suggestions: [] } })} />);
    expect(screen.getByText("question")).toBeInTheDocument();
  });
  it("done shows outcome; failed shows error", () => {
    const { rerender } = render(<AgentTile {...base} agent={agent("done")} assignment={asg({ state: "done", outcome: "Opened PR #88" })} />);
    expect(screen.getByTestId("tile-devops@hrns")).toHaveTextContent("Opened PR #88");
    rerender(<AgentTile {...base} agent={agent("failed")} assignment={asg({ state: "failed", error: "error_max_turns" })} />);
    expect(screen.getByTestId("tile-devops@hrns")).toHaveTextContent("error_max_turns");
  });
  it("free shows the assign box; Enter submits, Shift+Enter does not", async () => {
    const onAssign = vi.fn();
    render(<AgentTile {...base} onAssign={onAssign} agent={agent("free", null)} assignment={null} />);
    const box = screen.getByPlaceholderText(/assign work/i);
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onAssign).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onAssign).toHaveBeenCalledWith("devops@hrns", "line1\nline2");
  });
  it("click selects", async () => {
    const onSelect = vi.fn();
    render(<AgentTile {...base} onSelect={onSelect} agent={agent("working")} assignment={asg({})} />);
    await userEvent.click(screen.getByTestId("tile-devops@hrns"));
    expect(onSelect).toHaveBeenCalledWith("devops@hrns");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w ui -- AgentTile`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`ui/src/format.ts`:
```ts
export function elapsed(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return "—";
  const m = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
```

`ui/src/components/AssignBox.tsx`:
```tsx
import { useState, type KeyboardEvent } from "react";

export function AssignBox({ agentId, recent = [], onSubmit }: { agentId: string; recent?: string[]; onSubmit: (agentId: string, prompt: string) => void }) {
  const [text, setText] = useState(""); const [showRecent, setShowRecent] = useState(false);
  const submit = () => { const t = text.trim(); if (!t) return; onSubmit(agentId, t); setText(""); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "/" && text === "" && recent.length) { e.preventDefault(); setShowRecent(true); }
    else if (e.key === "Escape") setShowRecent(false);
  };
  return (
    <div className="assign" onClick={e => e.stopPropagation()}>
      <textarea rows={2} value={text} placeholder="Assign work… (⏎ to send, / for recent)" onChange={e => setText(e.target.value)} onKeyDown={onKey} />
      {showRecent && (
        <ul className="recent">{recent.map((r, i) => <li key={i} onClick={() => { setText(r); setShowRecent(false); }}>{r.slice(0, 80)}</li>)}</ul>
      )}
    </div>
  );
}
```

`ui/src/components/AgentTile.tsx`:
```tsx
import type { Agent, Assignment, RoleDef } from "../types";
import { AssignBox } from "./AssignBox";
import { basename, elapsed, usd } from "../format";

export interface AgentTileProps {
  agent: Agent; role: RoleDef | undefined; assignment: Assignment | null; selected: boolean; index: number; recent?: string[];
  onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
}

export function AgentTile({ agent, role, assignment, selected, index, recent, onSelect, onAssign }: AgentTileProps) {
  const a = assignment;
  const line = agent.state === "free" ? null
    : agent.state === "done" ? `✅ ${a?.outcome?.split("\n").filter(Boolean).at(-1) ?? "done"}`
    : agent.state === "failed" ? `❌ ${a?.error ?? "failed"}`
    : a?.activity ?? "";
  return (
    <div className={`tile ${selected ? "selected" : ""}`} data-state={agent.state} data-testid={`tile-${agent.id}`} onClick={() => onSelect(agent.id)}>
      {agent.state === "waiting" && <span className="badge">{a?.pending?.kind === "question" ? "question" : "needs you"}</span>}
      <span className="idx">{index < 9 ? index + 1 : ""}</span>
      <div className="hd">
        <div className="av">{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} — {agent.role}</div><div className="repo">{basename(agent.repo)}</div></div>
      </div>
      {line !== null && <div className="act">{agent.state === "working" && <span className="dot" />}{line}</div>}
      {agent.state === "free" && <AssignBox agentId={agent.id} recent={recent} onSubmit={onAssign} />}
      {a && <div className="ft"><span>#{a.id} · {elapsed(a.startedAt ?? a.createdAt)}{a.turns ? ` · ${a.turns} turns` : ""}</span><span>{usd(a.costUsd)}</span></div>}
    </div>
  );
}
```

`ui/src/components/AgentGrid.tsx`:
```tsx
import type { Agent, Assignment, RoleDef } from "../types";
import { AgentTile } from "./AgentTile";

export function AgentGrid({ agents, roles, assignments, selectedId, recentFor, onSelect, onAssign }: {
  agents: Agent[]; roles: RoleDef[]; assignments: Record<string, Assignment>; selectedId: string | null;
  recentFor: (agentId: string) => string[]; onSelect: (id: string) => void; onAssign: (id: string, prompt: string) => void;
}) {
  return (
    <div className="grid">
      {agents.map((agent, i) => (
        <AgentTile key={agent.id} agent={agent} index={i} role={roles.find(r => r.name === agent.role)}
          assignment={agent.currentAssignmentId ? assignments[agent.currentAssignmentId] ?? null : null}
          selected={agent.id === selectedId} recent={recentFor(agent.id)} onSelect={onSelect} onAssign={onAssign} />
      ))}
      {agents.length === 0 && <div className="empty">No agents yet — press <b>+ Spawn</b> to add one.</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w ui -- AgentTile`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AgentTile.tsx ui/src/components/AssignBox.tsx ui/src/components/AgentGrid.tsx ui/src/format.ts ui/test/AgentTile.test.tsx
git commit -m "feat(ui): agent tile, assign box and grid"
```

---

### Task 14: PendingPrompt (permission + question)

**Files:**
- Create: `ui/src/components/PendingPrompt.tsx`, `ui/test/PendingPrompt.test.tsx`

**Interfaces:**
- Produces: `<PendingPrompt pending onDecide(decision: Decision) />`. Permission variant: shows tool name + summarised input (`command` for Bash, `file_path` for file tools, else JSON), buttons **Allow** / **Always allow** (only when `suggestions.length > 0`) / **Deny**. Question variant: per question, header + option buttons (multi-select toggles; single-select answers immediately when there is exactly one question), plus a free-text input; **Send** submits `{kind:"answers", answers, response?}`.

- [ ] **Step 1: Failing tests**

`ui/test/PendingPrompt.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingPrompt } from "../src/components/PendingPrompt";
import type { Pending } from "../src/types";

const perm = (suggestions: unknown[] = []): Pending => ({ kind: "permission", toolUseId: "t1", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions });
const q = (multi = false, n = 1): Pending => ({ kind: "question", toolUseId: "t2", toolName: "AskUserQuestion", suggestions: [], input: { questions: Array.from({ length: n }, (_, i) => ({
  question: `Q${i + 1}?`, header: `H${i + 1}`, multiSelect: multi, options: [{ label: "main", description: "d1" }, { label: "develop", description: "d2" }] })) } });

describe("PendingPrompt permission", () => {
  it("shows command and Allow/Deny; Always only with suggestions", async () => {
    const onDecide = vi.fn();
    const { rerender } = render(<PendingPrompt pending={perm()} onDecide={onDecide} />);
    expect(screen.getByText(/kubectl rollout restart/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /always/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "allow" });
    rerender(<PendingPrompt pending={perm([{ type: "addRules" }])} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /always/i }));
    expect(onDecide).toHaveBeenLastCalledWith({ kind: "always" });
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDecide).toHaveBeenLastCalledWith({ kind: "deny" });
  });
});

describe("PendingPrompt question", () => {
  it("single question, single-select answers on click", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q()} onDecide={onDecide} />);
    expect(screen.getByText("Q1?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /develop/ }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "develop" } });
  });
  it("multi-select joins with comma and needs Send", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q(true)} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /main/ }));
    await userEvent.click(screen.getByRole("button", { name: /develop/ }));
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "main, develop" } });
  });
  it("free text goes to response", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q()} onDecide={onDecide} />);
    await userEvent.type(screen.getByPlaceholderText(/type an answer/i), "use trunk{Enter}");
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: {}, response: "use trunk" });
  });
  it("two questions wait for both before Send is enabled", async () => {
    const onDecide = vi.fn();
    render(<PendingPrompt pending={q(false, 2)} onDecide={onDecide} />);
    await userEvent.click(screen.getAllByRole("button", { name: /main/ })[0]);
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    await userEvent.click(screen.getAllByRole("button", { name: /develop/ })[1]);
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onDecide).toHaveBeenCalledWith({ kind: "answers", answers: { "Q1?": "main", "Q2?": "develop" } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w ui -- PendingPrompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`ui/src/components/PendingPrompt.tsx`:
```tsx
import { useState } from "react";
import type { Decision, Pending } from "../types";

interface Q { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }

function summarise(input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern;
  return typeof v === "string" ? v : JSON.stringify(input, null, 1).slice(0, 600);
}

export function PendingPrompt({ pending, onDecide }: { pending: Pending; onDecide: (d: Decision) => void }) {
  if (pending.kind === "permission") {
    return (
      <div className="qbox" data-testid="pending-permission">
        <div className="qtitle">Permission: {pending.toolName}</div>
        <pre className="cmd">{summarise(pending.input)}</pre>
        <div className="row">
          <button className="btn g" onClick={() => onDecide({ kind: "allow" })}>Allow</button>
          {pending.suggestions.length > 0 && <button className="btn" onClick={() => onDecide({ kind: "always" })}>Always allow</button>}
          <button className="btn d" onClick={() => onDecide({ kind: "deny" })}>Deny</button>
        </div>
      </div>
    );
  }
  return <QuestionPrompt questions={(pending.input.questions as Q[]) ?? []} onDecide={onDecide} />;
}

function QuestionPrompt({ questions, onDecide }: { questions: Q[]; onDecide: (d: Decision) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [free, setFree] = useState("");
  const single = questions.length === 1 && !questions[0].multiSelect;
  const answers = () => Object.fromEntries(Object.entries(picked).filter(([, v]) => v.length).map(([k, v]) => [k, v.join(", ")]));
  const complete = questions.every(q => (picked[q.question] ?? []).length > 0);
  const toggle = (q: Q, label: string) => {
    if (single) { onDecide({ kind: "answers", answers: { [q.question]: label } }); return; }
    setPicked(p => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  };
  const sendFree = () => { const t = free.trim(); if (!t) return; onDecide({ kind: "answers", answers: answers(), response: t }); };
  return (
    <div className="qbox" data-testid="pending-question">
      {questions.map(q => (
        <div key={q.question} className="q">
          <div className="qtitle">{q.header}: {q.question}</div>
          <div className="row">
            {q.options.map(o => (
              <button key={o.label} className={`btn ${(picked[q.question] ?? []).includes(o.label) ? "on" : ""}`} title={o.description} onClick={() => toggle(q, o.label)}>{o.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="row">
        <input value={free} placeholder="or type an answer…" onChange={e => setFree(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendFree(); }} />
        {!single && <button className="btn p" disabled={!complete} onClick={() => onDecide({ kind: "answers", answers: answers() })}>Send</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w ui -- PendingPrompt`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/PendingPrompt.tsx ui/test/PendingPrompt.test.tsx
git commit -m "feat(ui): inline permission and question prompt"
```

---

### Task 15: SidePanel, TopBar and SpawnDialog

**Files:**
- Create: `ui/src/components/SidePanel.tsx`, `ui/src/components/TopBar.tsx`, `ui/src/components/SpawnDialog.tsx`, `ui/test/SidePanel.test.tsx`

**Interfaces:**
- Produces:
  - `<SidePanel agent role assignment onDecide onCancel onAck onOpenTerminal />` — task text, activity feed (fetched via `api.transcript`, refetched when `assignment.activity` changes), `PendingPrompt` when waiting, outcome/error when finished, actions, memory list (`api.memory`).
  - `<TopBar counts spend connected waitingCount onCycleWaiting onSpawn />`.
  - `<SpawnDialog roles recentRepos onSpawn(input) onClose />`.

- [ ] **Step 1: Failing test**

`ui/test/SidePanel.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidePanel } from "../src/components/SidePanel";
import type { Agent, Assignment, RoleDef } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  transcript: vi.fn(async () => [{ ts: "", role: "assistant", kind: "tool_use", text: "Bash: kubectl get pods" }]),
  memory: vi.fn(async () => [{ file: "ns.md", name: "staging-ns", description: "namespace is hrns-stg" }]),
} }));

const role: RoleDef = { name: "devops", avatar: "🛠️", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" };
const agent: Agent = { id: "devops@hrns", role: "devops", repo: "/u/hrns", displayName: "Dev", createdAt: "", state: "waiting", currentAssignmentId: "a41" };
const asg: Assignment = { id: "a41", agentId: "devops@hrns", prompt: "Restart staging", createdAt: "", startedAt: null, endedAt: null, sessionId: "s1", state: "waiting",
  activity: "x", pending: { kind: "permission", toolUseId: "t1", toolName: "Bash", input: { command: "kubectl rollout restart" }, suggestions: [] }, outcome: null, error: null, turns: 2, costUsd: 0.3 };
const fns = { onDecide: vi.fn(), onCancel: vi.fn(), onAck: vi.fn(), onOpenTerminal: vi.fn() };
beforeEach(() => vi.clearAllMocks());

describe("SidePanel", () => {
  it("shows task, transcript, pending prompt, memory and actions", async () => {
    render(<SidePanel agent={agent} role={role} assignment={asg} {...fns} />);
    expect(screen.getByText("Restart staging")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Bash: kubectl get pods")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/staging-ns/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(fns.onDecide).toHaveBeenCalledWith("devops@hrns", "t1", { kind: "allow" });
    await userEvent.click(screen.getByRole("button", { name: /open in terminal/i }));
    expect(fns.onOpenTerminal).toHaveBeenCalledWith("devops@hrns");
    await userEvent.click(screen.getByRole("button", { name: /cancel task/i }));
    expect(fns.onCancel).toHaveBeenCalledWith("devops@hrns");
  });
  it("done state shows outcome and Ack", async () => {
    render(<SidePanel agent={{ ...agent, state: "done" }} role={role} assignment={{ ...asg, state: "done", pending: null, outcome: "Rolled out.\nHealth green." }} {...fns} />);
    expect(screen.getByText(/Health green/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /ack/i }));
    expect(fns.onAck).toHaveBeenCalledWith("devops@hrns");
  });
  it("empty selection shows a hint", () => {
    render(<SidePanel agent={null} role={undefined} assignment={null} {...fns} />);
    expect(screen.getByText(/select an agent/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w ui -- SidePanel`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three components**

`ui/src/components/SidePanel.tsx`:
```tsx
import { useEffect, useState } from "react";
import type { Agent, Assignment, Decision, MemoryFile, RoleDef } from "../types";
import { api } from "../api";
import { PendingPrompt } from "./PendingPrompt";
import { elapsed, usd } from "../format";

type Entry = { ts: string; role: string; kind: string; text: string };

export function SidePanel({ agent, role, assignment, onDecide, onCancel, onAck, onOpenTerminal }: {
  agent: Agent | null; role: RoleDef | undefined; assignment: Assignment | null;
  onDecide: (agentId: string, toolUseId: string, d: Decision) => void; onCancel: (id: string) => void; onAck: (id: string) => void; onOpenTerminal: (id: string) => void;
}) {
  const [feed, setFeed] = useState<Entry[]>([]); const [memory, setMemory] = useState<MemoryFile[]>([]);
  const asgId = assignment?.id; const activity = assignment?.activity; const agentId = agent?.id;

  useEffect(() => { if (!asgId) { setFeed([]); return; } let live = true; api.transcript(asgId).then(f => live && setFeed(f.slice(-30))).catch(() => {}); return () => { live = false; }; }, [asgId, activity]);
  useEffect(() => { if (!agentId) { setMemory([]); return; } let live = true; api.memory(agentId).then(m => live && setMemory(m)).catch(() => {}); return () => { live = false; }; }, [agentId, assignment?.state]);

  if (!agent) return <aside className="side"><p className="hint">Select an agent to see details. Press 1–9 to jump.</p></aside>;
  const a = assignment;
  return (
    <aside className="side" data-testid="side-panel">
      <div className="hd"><div className="av" data-state={agent.state}>{role?.avatar ?? "🤖"}</div>
        <div><div className="name">{agent.displayName} — {agent.role}</div><div className="repo">{agent.repo}{a ? ` · #${a.id}` : ""}</div></div></div>
      {a && <>
        <h4>Task</h4><div className="task">{a.prompt}</div>
        <h4>Recent activity</h4>
        <div className="transcript">{feed.map((e, i) => <div key={i} className={`e ${e.kind}`}>▸ {e.text}</div>)}{feed.length === 0 && <div className="e">…</div>}</div>
        {a.pending && <PendingPrompt pending={a.pending} onDecide={d => onDecide(agent.id, a.pending!.toolUseId, d)} />}
        {a.state === "done" && <><h4>Outcome</h4><pre className="outcome">{a.outcome}</pre></>}
        {a.state === "failed" && <><h4>Failed</h4><pre className="outcome err">{a.error}</pre></>}
        <div className="row">
          {a.sessionId && <button className="btn" onClick={() => onOpenTerminal(agent.id)}>Open in Terminal ↗</button>}
          {(a.state === "working" || a.state === "waiting") && <button className="btn d" onClick={() => onCancel(agent.id)}>Cancel task</button>}
          {(a.state === "done" || a.state === "failed") && <button className="btn p" onClick={() => onAck(agent.id)}>Ack → free</button>}
        </div>
        <div className="ft"><span>{elapsed(a.startedAt ?? a.createdAt)} · {a.turns} turns</span><span>{usd(a.costUsd)}</span></div>
      </>}
      {!a && <p className="hint">Idle. Type in the tile to assign work.</p>}
      <h4>Memory ({memory.length})</h4>
      <ul className="memory">{memory.map(m => <li key={m.file} title={m.description}>{m.name} <span className="dim">— {m.description}</span></li>)}</ul>
    </aside>
  );
}
```

`ui/src/components/TopBar.tsx`:
```tsx
import type { AgentState } from "../types";
import { usd } from "../format";

export function TopBar({ counts, spend, connected, waitingCount, onCycleWaiting, onSpawn }: {
  counts: Record<AgentState, number>; spend: number; connected: boolean; waitingCount: number; onCycleWaiting: () => void; onSpawn: () => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <header className="topbar">
      <span className="brand">⬢ AgentGrid</span>
      <span className="pill">{total} agents</span>
      <div className="sum">
        <span className="pill">● {counts.working} working</span>
        <button className={`pill w ${waitingCount ? "hot" : ""}`} onClick={onCycleWaiting} disabled={!waitingCount}>● {waitingCount} need you</button>
        <span className="pill">● {counts.done} done</span>
        {counts.failed > 0 && <span className="pill f">● {counts.failed} failed</span>}
        <span className="pill">○ {counts.free} free</span>
        <span className="pill">{usd(spend)} today</span>
        {!connected && <span className="pill f">disconnected</span>}
      </div>
      <button className="btn p" onClick={onSpawn}>+ Spawn</button>
    </header>
  );
}
```

`ui/src/components/SpawnDialog.tsx`:
```tsx
import { useState } from "react";
import type { RoleDef } from "../types";

export function SpawnDialog({ roles, recentRepos, onSpawn, onClose }: {
  roles: RoleDef[]; recentRepos: string[]; onSpawn: (input: { role: string; repo: string; displayName?: string }) => Promise<void>; onClose: () => void;
}) {
  const [role, setRole] = useState(roles[0]?.name ?? ""); const [repo, setRepo] = useState(recentRepos[0] ?? "");
  const [name, setName] = useState(""); const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!role || !repo.startsWith("/")) { setErr("Pick a role and an absolute repo path"); return; }
    try { await onSpawn({ role, repo: repo.trim(), displayName: name.trim() || undefined }); onClose(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <h3>Spawn agent</h3>
        <label>Role<select value={role} onChange={e => setRole(e.target.value)}>{roles.map(r => <option key={r.name} value={r.name}>{r.avatar} {r.name}</option>)}</select></label>
        <label>Repo path<input list="recent-repos" value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
          <datalist id="recent-repos">{recentRepos.map(r => <option key={r} value={r} />)}</datalist></label>
        <label>Name (optional)<input value={name} placeholder="auto" onChange={e => setName(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        <div className="row"><button className="btn p" onClick={submit}>Spawn</button><button className="btn" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w ui`
Expected: all UI tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components ui/test/SidePanel.test.tsx
git commit -m "feat(ui): side panel, top bar and spawn dialog"
```

---

### Task 16: App wiring — SSE, keyboard, notifications, styles

**Files:**
- Modify: `ui/src/App.tsx` (replace placeholder), `ui/src/styles.css` (fill)
- Create: `ui/src/hooks/useKeyboard.ts`, `ui/src/notify.ts`

**Interfaces:**
- Consumes: everything from Tasks 12–15.
- Produces: the working page. `useKeyboard(handlers: { select(i): void; allow(): void; deny(): void; open(): void; escape(): void })` ignores keys typed inside inputs/textareas. `notify.ts`: `setTitleCount(n)`, `notifyWaiting(agentName, text)`, `notifyFinished(agentName, ok)`, `settings` (`{ notifyWaiting: true, notifyFinished: false }` persisted in `localStorage`).

- [ ] **Step 1: Keyboard hook and notifications**

`ui/src/hooks/useKeyboard.ts`:
```ts
import { useEffect } from "react";

export function useKeyboard(h: { select: (i: number) => void; allow: () => void; deny: () => void; open: () => void; escape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) { if (e.key === "Escape") t.blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "9") h.select(Number(e.key) - 1);
      else if (e.key === "a") h.allow();
      else if (e.key === "d") h.deny();
      else if (e.key === "o") h.open();
      else if (e.key === "Escape") h.escape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
```

`ui/src/notify.ts`:
```ts
export const settings = {
  get notifyWaiting() { try { return localStorage.getItem("ag.notifyWaiting") !== "0"; } catch { return true; } },
  set notifyWaiting(v: boolean) { try { localStorage.setItem("ag.notifyWaiting", v ? "1" : "0"); } catch {} },
  get notifyFinished() { try { return localStorage.getItem("ag.notifyFinished") === "1"; } catch { return false; } },
  set notifyFinished(v: boolean) { try { localStorage.setItem("ag.notifyFinished", v ? "1" : "0"); } catch {} },
};

export function setTitleCount(n: number) { document.title = n > 0 ? `(${n}) AgentGrid` : "AgentGrid"; }

function beep() {
  try { const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12); } catch {}
}

async function push(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") new Notification(title, { body });
}

export function notifyWaiting(agentName: string, text: string) { if (!settings.notifyWaiting) return; beep(); void push(`${agentName} needs you`, text); }
export function notifyFinished(agentName: string, ok: boolean) { if (!settings.notifyFinished) return; void push(`${agentName} ${ok ? "finished" : "failed"}`, ""); }
```

- [ ] **Step 2: App**

`ui/src/App.tsx`:
```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds } from "./state/reducer";
import { AgentGrid } from "./components/AgentGrid";
import { SidePanel } from "./components/SidePanel";
import { TopBar } from "./components/TopBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { useKeyboard } from "./hooks/useKeyboard";
import { notifyFinished, notifyWaiting, setTitleCount, settings } from "./notify";
import type { Decision } from "./types";

export function App() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const prevStates = useRef<Record<string, string>>({});
  const showErr = (e: unknown) => { setToast((e as Error).message); setTimeout(() => setToast(null), 4000); };

  useEffect(() => api.subscribe(st => dispatch({ type: "snapshot", state: st }), ev => dispatch({ type: "change", event: ev }), v => dispatch({ type: "connected", value: v })), []);

  // transitions → notifications + title
  useEffect(() => {
    for (const a of s.agents) {
      const prev = prevStates.current[a.id];
      if (prev && prev !== a.state) {
        const asg = assignmentFor(s, a);
        if (a.state === "waiting") notifyWaiting(a.displayName, asg?.pending?.kind === "question" ? "has a question" : `wants to run ${asg?.pending?.toolName ?? "a tool"}`);
        if (a.state === "done" || a.state === "failed") notifyFinished(a.displayName, a.state === "done");
      }
      prevStates.current[a.id] = a.state;
    }
    setTitleCount(waitingIds(s).length);
  }, [s]);

  const selected = s.agents.find(a => a.id === s.selectedId) ?? null;
  const selectedAsg = selected ? assignmentFor(s, selected) : null;
  const recentRepos = useMemo(() => [...new Set(s.agents.map(a => a.repo))], [s.agents]);
  const recentFor = useCallback((id: string) => [...new Set(Object.values(s.assignments).filter(a => a.agentId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => a.prompt))].slice(0, 8), [s.assignments]);

  const cycleWaiting = useCallback(() => { const ids = waitingIds(s); if (!ids.length) return; const i = ids.indexOf(s.selectedId ?? ""); dispatch({ type: "select", id: ids[(i + 1) % ids.length] }); }, [s]);
  const decide = useCallback((agentId: string, toolUseId: string, d: Decision) => api.answer(agentId, toolUseId, d).catch(showErr), []);
  const openTerminal = useCallback((id: string) => api.openTerminal(id).then(r => { if (!r.opened) { navigator.clipboard?.writeText(r.command); setToast(`Copied: ${r.command}`); setTimeout(() => setToast(null), 6000); } }).catch(showErr), []);

  useKeyboard(useMemo(() => ({
    select: (i: number) => { const a = s.agents[i]; if (a) dispatch({ type: "select", id: a.id }); },
    allow: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "allow" }); },
    deny: () => { if (selected && selectedAsg?.pending?.kind === "permission") void decide(selected.id, selectedAsg.pending.toolUseId, { kind: "deny" }); },
    open: () => { if (selected && selectedAsg?.sessionId) void openTerminal(selected.id); },
    escape: () => { setSpawnOpen(false); dispatch({ type: "select", id: null }); },
  }), [s.agents, selected, selectedAsg, decide, openTerminal]));

  return (
    <div className="app">
      <TopBar counts={counts(s)} spend={todaySpend(s)} connected={s.connected} waitingCount={waitingIds(s).length} onCycleWaiting={cycleWaiting} onSpawn={() => setSpawnOpen(true)} />
      <div className="split">
        <AgentGrid agents={s.agents} roles={s.roles} assignments={s.assignments} selectedId={s.selectedId} recentFor={recentFor}
          onSelect={id => dispatch({ type: "select", id })}
          onAssign={(id, prompt) => api.assign(id, prompt).then(() => dispatch({ type: "select", id })).catch(showErr)} />
        <SidePanel agent={selected} role={s.roles.find(r => r.name === selected?.role)} assignment={selectedAsg}
          onDecide={decide} onCancel={id => api.cancel(id).catch(showErr)} onAck={id => api.ack(id).catch(showErr)} onOpenTerminal={openTerminal} />
      </div>
      <footer className="foot">
        <label><input type="checkbox" defaultChecked={settings.notifyWaiting} onChange={e => (settings.notifyWaiting = e.target.checked)} /> notify when someone needs me</label>
        <label><input type="checkbox" defaultChecked={settings.notifyFinished} onChange={e => (settings.notifyFinished = e.target.checked)} /> notify on done/failed</label>
        <span className="dim">keys: 1–9 select · a allow · d deny · o terminal · esc</span>
      </footer>
      {spawnOpen && <SpawnDialog roles={s.roles} recentRepos={recentRepos} onSpawn={async i => { const a = await api.createAgent(i); dispatch({ type: "select", id: a.id }); }} onClose={() => setSpawnOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Styles**

`ui/src/styles.css`:
```css
:root { color-scheme: dark; --bg:#0f1115; --panel:#161a21; --line:#262a33; --fg:#e6e8ee; --dim:#9aa3b2; --dim2:#6b7484;
  --blue:#3b82f6; --amber:#f59e0b; --green:#22c55e; --red:#ef4444; --grey:#4a5262; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 13px/1.4 -apple-system, system-ui, sans-serif; }
.app { display:flex; flex-direction:column; height:100vh; }
.topbar { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); }
.brand { font-weight:700; letter-spacing:.3px; }
.sum { display:flex; gap:8px; margin-left:auto; font-size:12px; color:var(--dim); }
.pill { padding:2px 9px; border-radius:99px; background:#1b1f27; border:1px solid #2b3140; color:inherit; font:inherit; }
.pill.w { border-color:var(--amber); color:#ffd166; } .pill.w.hot { background:#3a2a05; cursor:pointer; } .pill.f { border-color:var(--red); color:#fca5a5; }
button.pill:disabled { opacity:.6; }
.split { display:grid; grid-template-columns: 1fr 340px; gap:12px; padding:12px 16px; flex:1; min-height:0; }
.grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:10px; align-content:start; overflow:auto; }
.empty { color:var(--dim2); padding:40px; grid-column:1/-1; text-align:center; }
.tile { position:relative; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; min-height:120px; cursor:pointer; --ring:var(--grey); }
.tile.selected { outline:2px solid #6b8cff; }
.tile[data-state="free"] { opacity:.8; } .tile[data-state="working"] { --ring:var(--blue); }
.tile[data-state="waiting"] { --ring:var(--amber); border-color:#f59e0b66; box-shadow:0 0 0 1px #f59e0b33, 0 0 18px #f59e0b22; }
.tile[data-state="done"] { --ring:var(--green); border-color:#22c55e55; } .tile[data-state="failed"] { --ring:var(--red); border-color:#ef444455; }
.hd { display:flex; align-items:center; gap:10px; }
.av { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:20px; background:#232833; box-shadow:0 0 0 2.5px var(--ring); }
.side .av[data-state="waiting"] { --ring:var(--amber); } .side .av[data-state="working"] { --ring:var(--blue); } .side .av[data-state="done"] { --ring:var(--green); } .side .av[data-state="failed"] { --ring:var(--red); }
.name { font-weight:600; } .repo { font-size:11px; color:var(--dim2); font-family:ui-monospace, monospace; }
.act { font-size:12px; color:#c3c9d5; margin-top:10px; min-height:32px; white-space:pre-wrap; word-break:break-word; }
.dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--blue); margin-right:6px; animation:blink 1.2s infinite; }
@keyframes blink { 50% { opacity:.2 } }
.ft { display:flex; justify-content:space-between; font-size:11px; color:var(--dim2); margin-top:8px; font-family:ui-monospace, monospace; }
.badge { position:absolute; top:-7px; right:-7px; background:var(--amber); color:#111; font-weight:700; font-size:11px; padding:2px 7px; border-radius:99px; }
.idx { position:absolute; top:6px; right:8px; font-size:10px; color:var(--dim2); font-family:ui-monospace, monospace; }
.assign { margin-top:8px; } .assign textarea { width:100%; resize:none; background:#0f1115; border:1px dashed #2b3140; color:var(--fg); border-radius:8px; padding:6px 8px; font:inherit; }
.recent { list-style:none; margin:4px 0 0; padding:0; background:#0f1115; border:1px solid var(--line); border-radius:6px; max-height:140px; overflow:auto; }
.recent li { padding:4px 8px; cursor:pointer; font-size:12px; } .recent li:hover { background:#1b1f27; }
.btn { font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid #2b3140; background:#1b1f27; color:#dfe3ea; cursor:pointer; }
.btn.p { background:#2563eb; border-color:#2563eb; color:#fff; } .btn.g { background:#15803d; border-color:#15803d; color:#fff; } .btn.d { border-color:#7f1d1d; color:#fca5a5; }
.btn.on { background:#2563eb55; border-color:#2563eb; } .btn:disabled { opacity:.5; cursor:default; }
.row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center; } .row input { flex:1; background:#161a21; border:1px solid #2b3140; color:var(--fg); border-radius:6px; padding:5px 8px; font:inherit; }
.side { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; overflow:auto; font-size:12px; }
.side h4 { margin:14px 0 6px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; }
.task { white-space:pre-wrap; color:#c3c9d5; }
.transcript { font-family:ui-monospace, monospace; font-size:11px; color:#aab2c0; line-height:1.5; background:#0f1115; border-radius:6px; padding:8px; max-height:220px; overflow:auto; }
.transcript .tool_use { color:#ffd166; } .transcript .tool_result { color:var(--dim2); }
.qbox { background:#0f1115; border:1px solid #f59e0b55; border-radius:8px; padding:10px; margin-top:10px; }
.qtitle { font-weight:600; margin-bottom:4px; } .cmd { white-space:pre-wrap; word-break:break-all; color:#ffd166; margin:4px 0; font-size:11px; }
.outcome { white-space:pre-wrap; background:#0f1115; border-radius:6px; padding:8px; font-size:12px; } .outcome.err { color:#fca5a5; }
.memory { list-style:none; padding:0; margin:0; } .memory li { padding:2px 0; } .dim { color:var(--dim2); }
.hint { color:var(--dim2); font-style:italic; }
.foot { display:flex; gap:18px; padding:6px 16px; border-top:1px solid var(--line); font-size:11px; color:var(--dim); }
.modal { position:fixed; inset:0; background:#0009; display:flex; align-items:center; justify-content:center; }
.dialog { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; width:420px; display:flex; flex-direction:column; gap:10px; }
.dialog label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--dim); }
.dialog input, .dialog select { background:#0f1115; border:1px solid #2b3140; color:var(--fg); border-radius:6px; padding:6px 8px; font:inherit; }
.err { color:#fca5a5; }
.toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:#1b1f27; border:1px solid var(--line); padding:8px 14px; border-radius:8px; }
@media (max-width: 900px) { .split { grid-template-columns:1fr; } }
```

- [ ] **Step 4: Build and manual smoke**

Run: `npm run build -w ui && AGENTGRID_FAKE=1 AGENTGRID_HOME=/tmp/ag-demo npm run serve -w server`
Open http://127.0.0.1:4800 → Spawn a `coder` into any absolute path → type "hello" in its tile → tile goes working → amber "needs you" → side panel shows `echo hi` → Allow → done → Ack → free. Tab title shows `(1) AgentGrid` while waiting. Stop the server.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all server and UI tests PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src
git commit -m "feat(ui): wire app with SSE, keyboard shortcuts, notifications and styles"
```

---

### Task 17: Playwright smoke test + README

**Files:**
- Create: `ui/playwright.config.ts`, `ui/e2e/smoke.spec.ts`, `README.md`

**Interfaces:**
- Consumes: `AGENTGRID_FAKE=1` server mode (Task 11), built UI (Task 16).

- [ ] **Step 1: Playwright config**

`ui/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e", timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4811", headless: true },
  webServer: {
    command: "npm run build && AGENTGRID_FAKE=1 AGENTGRID_PORT=4811 AGENTGRID_HOME=$(mktemp -d) npm run serve -w ../server",
    url: "http://127.0.0.1:4811/api/state", reuseExistingServer: false, timeout: 120_000,
  },
});
```

- [ ] **Step 2: Smoke test**

`ui/e2e/smoke.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("spawn → assign → answer permission → ack", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await page.getByRole("button", { name: "+ Spawn" }).click();
  await page.getByPlaceholder("/Users/you/project").fill("/tmp");
  await page.getByRole("button", { name: "Spawn", exact: true }).click();

  const tile = page.getByTestId(/^tile-/).first();
  await expect(tile).toHaveAttribute("data-state", "free");
  await tile.getByPlaceholder(/assign work/i).fill("say hello");
  await tile.getByPlaceholder(/assign work/i).press("Enter");

  await expect(tile).toHaveAttribute("data-state", "waiting");
  await expect(page).toHaveTitle("(1) AgentGrid");
  await expect(page.getByTestId("pending-permission")).toContainText("echo hi");
  await page.getByRole("button", { name: "Allow", exact: true }).click();

  await expect(tile).toHaveAttribute("data-state", "done");
  await expect(tile).toContainText("All done (fake).");
  await page.getByRole("button", { name: /Ack/ }).click();
  await expect(tile).toHaveAttribute("data-state", "free");
  await expect(page).toHaveTitle("AgentGrid");
});
```

- [ ] **Step 3: Run**

Run: `npx playwright install chromium` (once), then `npm run e2e -w ui`
Expected: 1 passed.

- [ ] **Step 4: README**

`README.md`:
```markdown
# AgentGrid

A local dashboard for running a roster of Claude Code agents in parallel. Each tile is a persona (role × repo); assign work with one keystroke, answer permissions and questions inline, and open the full session in a terminal when you need depth.

## Run
    npm install
    npm run build
    npm run serve          # http://127.0.0.1:4800

Roles live in `~/.agentgrid/roles/*.md` (defaults copied on first run). Data in `~/.agentgrid/`.

## Develop
    npm test                              # unit tests (server + ui)
    npm run test:live -w server           # real SDK integration test (costs cents)
    npm run e2e -w ui                     # Playwright smoke against the fake runner
    AGENTGRID_FAKE=1 npm run serve        # server with a scripted runner (no API calls)
    npm run dev -w ui                     # Vite dev server proxying /api to :4800

Design: `docs/superpowers/specs/2026-09-11-agentgrid-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add ui/playwright.config.ts ui/e2e README.md
git commit -m "test(ui): Playwright smoke test; add README"
```

---

## Self-review against the spec

- §5 domain model → Tasks 1–4 (types, roles, agents, assignments, memory listing, state machine in Task 6).
- §6.1 Store → Tasks 3–4; §6.2 Runner incl. `always`/`deny`/`answers`, cancel keeps sessionId, restart recovery → Tasks 6–7; §6.3 API incl. status codes → Tasks 8–10; §6.4 limits → `maxTurns` + `maxBudgetUsd` in Task 7.
- §7 UI: layout B → Task 16 `.split`; components → Tasks 13–15; attention (title, notifications, cycle-waiting button) and keyboard → Task 16; assign box `/` recent → Task 13; not-in-v1 list respected.
- §8 prompt assembly → Task 5 (snapshot); done detection → Task 6; cancel → Task 6.
- §9 testing: unit (Tasks 2–10, 12–15), live opt-in (Task 11), UI component + Playwright (Tasks 13–15, 17).
- Roles directory watcher (§5.1 "server watches the directory") → Task 11 `watch()`.
- Gap noted and accepted: live per-turn cost is not shown until `result` (spec §11 risk); `costUsd` stays 0 while working.
