# Automated Bug-Fix Workflow — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a tracker ticket, drive an agent through analyze → plan gate → implement → diff gate → open PR, inside AgentGrid.

**Architecture:** A server-owned stage machine (`BugTask`) whose every stage is one ordinary AgentGrid assignment on a dedicated `bugfix` agent that resumes the same Claude session across stages. Work happens in a git worktree on `bugfix/<KEY>`. The tracker is reached through the agent's MCP tools via short headless queries; the forge through a CLI adapter in the server. Gates are server state rendered as cards in the existing side panel.

**Tech Stack:** Node 22 + TypeScript (ESM, `.js` import suffixes), Express 5, vitest + supertest, React 19 + Vite, `@anthropic-ai/claude-agent-sdk` 0.3.268, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-25-bugfix-workflow-design.md`

## Global Constraints

- Phase 1 only. `monitoring` is a resting state with no watcher; Phase 2 adds the watcher, review loop, merge and cleanup. Do not build them here.
- Nothing irreversible happens unattended: push and PR creation happen only in the `opening-pr` stage, which is entered by a user click on the diff gate.
- The server verifies work rather than trusting the agent: it computes the diff with `git diff`, counts commits, and finds the PR through the forge adapter.
- The server refuses push/PR when the task branch equals the repo's default branch or has no commits ahead of base.
- AgentGrid stores no credentials. Tracker auth lives in Claude Code's MCP store; forge auth in the forge CLI's own store.
- Data root is `~/.agentgrid/` via `resolveHome()` (`AGENTGRID_HOME` override); bug tasks live in `<home>/bugtasks/`.
- All new server code is ESM TypeScript with `.js` import suffixes, and must pass `npx tsc -p server/tsconfig.json --noEmit`.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_017SD5eo7qEmqYFa7YiLYjsK`

## File structure

```
server/src/bugfix/
  types.ts            BugTask, BugStage, GateKind, TrackerIssue, IssueSummary, PrInfo, BugEvent
  stages.ts           pure stage machine: nextStage(task, event)
  store.ts            BugTaskStore: CRUD + artifact dir, atomic writes, "event" emitter
  git.ts              GitOps: default branch, worktree create/remove, commits ahead, diff
  integrations.ts     integrations.json read/write, forge detection, project→repo map
  tracker.ts          TrackerProvider (MCP-mediated headless queries) + schema validation
  prompts.ts          stage prompt rendering from presets/stages/*.md
  forge/types.ts      ForgeAdapter interface
  forge/github.ts     gh adapter
  forge/index.ts      adapter registry / factory
  engine.ts           BugFixEngine: intake, stage dispatch, gate resolution
server/presets/
  tracker/jira.md     prompt templates for listMyIssues / fetchIssue / comment
  stages/analyze.md   stage prompts
  stages/implement.md
  stages/open-pr.md
server/src/api/app.ts        + /api/bugtasks routes, AppDeps.bugs
server/src/start.ts          wire engine, integrations, tracker, forge
server/test/bugfix/*.test.ts unit + integration tests
ui/src/types.ts              re-exports the new server types
ui/src/api.ts                bug task API client
ui/src/state/reducer.ts      bugTasks in UiState + selectors
ui/src/components/BugLauncher.tsx   launcher dialog
ui/src/components/BugPanel.tsx      issue header + timeline + gate cards
ui/src/components/SidePanel.tsx     renders BugPanel for bug agents
ui/src/components/TopBar.tsx        "🐞 Fix a bug" button
ui/e2e/bugfix.spec.ts               end-to-end in fake mode
```

---

### Task 1: Spike — does a headless SDK session reuse MCP OAuth?

**Files:**
- Create (throwaway): `/tmp/mcp-spike.mts`
- Modify: `docs/superpowers/specs/2026-09-25-bugfix-workflow-design.md` (record the answer in §5.1)

**Interfaces:**
- Produces: a recorded yes/no that Task 7 depends on. If **no**, Task 7 implements the REST-token fallback instead of the MCP tracker, and the spec section is rewritten to match.

This is a spike: the deliverable is an answer, not code. Do not keep the script.

- [ ] **Step 1: Check what MCP servers exist**

```bash
claude mcp list
```
Record the output. If an Atlassian (or any remote OAuth) MCP is already configured and authenticated, use it for step 3. If none is configured, add one:

```bash
claude mcp add --scope user --transport sse atlassian https://mcp.atlassian.com/v1/sse
claude mcp list          # confirm it appears
```
If that URL is rejected, find the current one at https://support.atlassian.com (search "Atlassian Remote MCP Server") and use that. Record which URL worked.

- [ ] **Step 2: Authenticate it interactively, exactly as the app will**

```bash
cd /tmp && claude
# in the TUI: /mcp  → select the server → complete the browser OAuth → then /exit
```
Record whether authentication succeeded and where the credentials appear to be stored (`ls -la ~/.claude/` before/after, look for a new or changed file — do **not** print file contents).

- [ ] **Step 3: Try to use it from a headless SDK session**

`/tmp/mcp-spike.mts` (run from `server/` so the SDK resolves):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
const q = query({
  prompt: "List the MCP tools you can call. Then, using only those tools, tell me my own user/account name in the tracker. Reply with one line: TOOLS=<count> USER=<name-or-UNAVAILABLE>",
  options: { cwd: "/tmp", settingSources: ["user"], model: "claude-opus-5", maxTurns: 8,
             permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
});
for await (const m of q) {
  if (m.type === "assistant") for (const b of (m as any).message.content) if (b.type === "text") console.log("TEXT:", b.text);
  if (m.type === "result") console.log("RESULT:", (m as any).subtype, (m as any).result ?? "");
}
```

```bash
cd server && cp /tmp/mcp-spike.mts . && npx tsx mcp-spike.mts; rm mcp-spike.mts
```

- [ ] **Step 4: Record the verdict in the spec**

Edit §5.1 of the spec, replacing the "**Risk:**" paragraph with what you found — one of:

- *Verified:* headless sessions inherit the interactive MCP OAuth (`settingSources: ["user"]`); include the tool count you saw.
- *Not verified:* headless sessions cannot use the MCP credentials — describe the failure, and change §5.1 to specify the REST-token tracker adapter (site URL + email + API token stored in `integrations.json`, server-side `fetch`) as the Phase 1 implementation, keeping the same four calls and schema.

- [ ] **Step 5: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-09-25-bugfix-workflow-design.md
git commit -m "docs: record MCP OAuth reuse finding for the bug-fix workflow"
```

---

### Task 2: BugTask types and stage machine

**Files:**
- Create: `server/src/bugfix/types.ts`, `server/src/bugfix/stages.ts`
- Test: `server/test/bugfix/stages.test.ts`

**Interfaces:**
- Produces: every type below (used verbatim by later tasks) and `nextStage(task, event): Transition`.

- [ ] **Step 1: Write the types**

`server/src/bugfix/types.ts`:

```ts
export type BugStage =
  | "intake" | "analyzing" | "plan-review" | "implementing" | "diff-review"
  | "opening-pr" | "monitoring" | "review-feedback" | "rebase" | "approved"
  | "merging" | "done" | "cancelled" | "failed";

export type GateKind = "plan" | "diff" | "review" | "merge" | "rebase";

/** Normalised ticket — every tracker preset returns this shape. */
export interface TrackerIssue {
  key: string; title: string; url: string;
  status: string; priority: string;
  description: string; acceptanceCriteria: string[];
}
export interface IssueSummary { key: string; title: string; url: string; status: string; priority: string }

export interface PrInfo {
  number: number; url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  checks: string | null;
  mergeable: string | null;
  lastSeenEventAt: string;
}

export interface BugTask {
  id: string;                     // "bt1"
  issue: TrackerIssue;
  trackerProject: string;         // e.g. "PAY" — key prefix
  sourceRepo: string;             // the repo the user picked
  worktree: string;               // <repo>/.worktrees/bugfix-<KEY>
  branch: string;                 // bugfix/<KEY>
  baseBranch: string;
  agentId: string;
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string } | null;
  mergePolicy: "ask" | "auto";
  mergeMethod: "squash" | "merge" | "rebase";
  pr: PrInfo | null;
  costUsd: number;
  history: Array<{ stage: BugStage; at: string; note: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BugEvent =
  | { type: "stage-done" }                       // the stage's assignment finished and verified
  | { type: "stage-failed"; reason: string }
  | { type: "approve" }
  | { type: "request-changes"; text: string }
  | { type: "cancel" }
  | { type: "retry" };

export interface Transition {
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string } | null;
  error: string | null;
  note: string;
  /** Stage the engine must now run an assignment for; null when waiting on a human or resting. */
  run: BugStage | null;
}

/** Stages whose work is done by an agent assignment. */
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr"];
/** Stages that are waiting on a human click. */
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
```

- [ ] **Step 2: Write the failing stage-machine test**

`server/test/bugfix/stages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStage } from "../../src/bugfix/stages.js";
import type { BugStage, BugTask } from "../../src/bugfix/types.js";

const task = (stage: BugStage, extra: Partial<BugTask> = {}): BugTask => ({
  id: "bt1",
  issue: { key: "PAY-1", title: "t", url: "u", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] },
  trackerProject: "PAY", sourceRepo: "/r", worktree: "/r/.worktrees/bugfix-PAY-1", branch: "bugfix/PAY-1",
  baseBranch: "main", agentId: "bugfix@r", stage, gate: null, mergePolicy: "ask", mergeMethod: "squash",
  pr: null, costUsd: 0, history: [], error: null, createdAt: "", updatedAt: "", ...extra,
});

describe("nextStage — happy path through Phase 1", () => {
  it("intake → analyzing runs the analyze stage", () => {
    expect(nextStage(task("intake"), { type: "stage-done" })).toMatchObject({ stage: "analyzing", run: "analyzing", gate: null });
  });
  it("analyzing done opens the plan gate and runs nothing", () => {
    const t = nextStage(task("analyzing"), { type: "stage-done" });
    expect(t).toMatchObject({ stage: "plan-review", run: null });
    expect(t.gate).toMatchObject({ kind: "plan" });
  });
  it("approving the plan runs implementing", () => {
    expect(nextStage(task("plan-review"), { type: "approve" })).toMatchObject({ stage: "implementing", run: "implementing", gate: null });
  });
  it("implementing done opens the diff gate", () => {
    const t = nextStage(task("implementing"), { type: "stage-done" });
    expect(t).toMatchObject({ stage: "diff-review", run: null });
    expect(t.gate).toMatchObject({ kind: "diff" });
  });
  it("approving the diff runs opening-pr, which rests in monitoring", () => {
    expect(nextStage(task("diff-review"), { type: "approve" })).toMatchObject({ stage: "opening-pr", run: "opening-pr" });
    expect(nextStage(task("opening-pr"), { type: "stage-done" })).toMatchObject({ stage: "monitoring", run: null, gate: null });
  });
});

describe("nextStage — loops, failures, cancel", () => {
  it("request-changes at the plan gate re-runs analyzing with the note", () => {
    const t = nextStage(task("plan-review"), { type: "request-changes", text: "cover the retry path too" });
    expect(t).toMatchObject({ stage: "analyzing", run: "analyzing" });
    expect(t.note).toBe("cover the retry path too");
  });
  it("request-changes at the diff gate re-runs implementing with the note", () => {
    const t = nextStage(task("diff-review"), { type: "request-changes", text: "split that function" });
    expect(t).toMatchObject({ stage: "implementing", run: "implementing", note: "split that function" });
  });
  it("any stage can fail, and retry re-runs the stage it failed in", () => {
    const f = nextStage(task("implementing"), { type: "stage-failed", reason: "no commits on branch" });
    expect(f).toMatchObject({ stage: "failed", run: null, error: "no commits on branch" });
    const r = nextStage(task("failed", { history: [{ stage: "implementing", at: "", note: "" }] }), { type: "retry" });
    expect(r).toMatchObject({ stage: "implementing", run: "implementing", error: null });
  });
  it("cancel works from any non-terminal stage and is refused afterwards", () => {
    expect(nextStage(task("implementing"), { type: "cancel" })).toMatchObject({ stage: "cancelled", run: null });
    expect(() => nextStage(task("done"), { type: "cancel" })).toThrow(/terminal/);
  });
  it("rejects events that make no sense for the stage", () => {
    expect(() => nextStage(task("analyzing"), { type: "approve" })).toThrow(/cannot approve/i);
    expect(() => nextStage(task("plan-review"), { type: "stage-done" })).toThrow(/waiting/i);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/stages.test.ts`
Expected: FAIL — cannot find module `../../src/bugfix/stages.js`.

- [ ] **Step 4: Implement the stage machine**

`server/src/bugfix/stages.ts`:

```ts
import { GATE_STAGES, TERMINAL_STAGES, type BugEvent, type BugStage, type BugTask, type GateKind, type Transition } from "./types.js";

const gate = (kind: GateKind): Transition["gate"] => ({ kind, openedAt: new Date().toISOString() });
const go = (stage: BugStage, run: BugStage | null, note = "", error: string | null = null): Transition => ({ stage, run, gate: null, note, error });
const wait = (stage: BugStage, kind: GateKind): Transition => ({ stage, run: null, gate: gate(kind), note: "", error: null });

/**
 * The whole Phase 1 workflow in one pure function: given where a task is and what
 * happened, say where it goes and which stage (if any) the engine must now run.
 * Phase 2 adds the monitoring events; `monitoring` rests here.
 */
export function nextStage(task: BugTask, event: BugEvent): Transition {
  if (TERMINAL_STAGES.includes(task.stage) && event.type !== "retry") {
    throw new Error(`task ${task.id} is in terminal stage ${task.stage}`);
  }
  switch (event.type) {
    case "cancel":
      return go("cancelled", null);

    case "stage-failed":
      return go("failed", null, "", event.reason);

    case "retry": {
      if (task.stage !== "failed") throw new Error(`can only retry a failed task (is ${task.stage})`);
      const last = [...task.history].reverse().find(h => h.stage !== "failed");
      if (!last) throw new Error("nothing to retry");
      return go(last.stage, last.stage, "", null);
    }

    case "approve": {
      if (!GATE_STAGES.includes(task.stage)) throw new Error(`cannot approve while ${task.stage}`);
      return task.stage === "plan-review" ? go("implementing", "implementing") : go("opening-pr", "opening-pr");
    }

    case "request-changes": {
      if (!GATE_STAGES.includes(task.stage)) throw new Error(`cannot request changes while ${task.stage}`);
      const back: BugStage = task.stage === "plan-review" ? "analyzing" : "implementing";
      return go(back, back, event.text);
    }

    case "stage-done": {
      if (GATE_STAGES.includes(task.stage)) throw new Error(`${task.stage} is waiting on a human, not on the agent`);
      switch (task.stage) {
        case "intake": return go("analyzing", "analyzing");
        case "analyzing": return wait("plan-review", "plan");
        case "implementing": return wait("diff-review", "diff");
        case "opening-pr": return go("monitoring", null);   // Phase 2 starts the watcher here
        default: throw new Error(`no transition from ${task.stage} on stage-done`);
      }
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && npx vitest run test/bugfix/stages.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 11 tests pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix server/test/bugfix
git commit -m "feat(bugfix): BugTask types and the Phase 1 stage machine"
```

---

### Task 3: BugTaskStore

**Files:**
- Create: `server/src/bugfix/store.ts`
- Test: `server/test/bugfix/store.test.ts`

**Interfaces:**
- Consumes: `BugTask`, `BugStage`, `Transition` (Task 2); `paths(home)` from `server/src/store/paths.ts`.
- Produces:
  - `class BugTaskStore extends EventEmitter` with `init()`, `list(): BugTask[]`, `get(id): BugTask` (throws `NotFound`), `byAgent(agentId): BugTask | null`, `create(input): Promise<BugTask>`, `apply(id, t: Transition): Promise<BugTask>`, `patch(id, p: Partial<BugTask>): Promise<BugTask>`, `dir(id): string`, `writeArtifact(id, name, data): Promise<void>`, `readArtifact(id, name): Promise<string | null>`.
  - Emits `"event"` with `{ type: "bugtask"; task: BugTask }`.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { NotFound } from "../../src/store/store.js";
import type { TrackerIssue } from "../../src/bugfix/types.js";

const issue: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: ["a"] };
let home: string; let store: BugTaskStore; let events: unknown[];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "bt-"));
  store = new BugTaskStore(home);
  events = [];
  store.on("event", e => events.push(e));
  await store.init();
});

const mk = () => store.create({ issue, trackerProject: "PAY", sourceRepo: "/r/payments", worktree: "/r/payments/.worktrees/bugfix-PAY-42", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@payments", mergePolicy: "ask", mergeMethod: "squash" });

describe("BugTaskStore", () => {
  it("creates sequential tasks at stage intake, persists them, emits", async () => {
    const t = await mk();
    expect(t.id).toBe("bt1");
    expect(t).toMatchObject({ stage: "intake", gate: null, pr: null, error: null, costUsd: 0 });
    expect(JSON.parse(await readFile(path.join(home, "bugtasks", "bt1.json"), "utf8"))).toEqual(t);
    expect(events).toEqual([{ type: "bugtask", task: t }]);
    expect((await mk()).id).toBe("bt2");
  });

  it("reloads from disk and continues the id counter", async () => {
    await mk();
    const again = new BugTaskStore(home); await again.init();
    expect(again.list().map(t => t.id)).toEqual(["bt1"]);
    const next = await again.create({ issue, trackerProject: "PAY", sourceRepo: "/r/p", worktree: "/w", branch: "b", baseBranch: "main", agentId: "a", mergePolicy: "ask", mergeMethod: "squash" });
    expect(next.id).toBe("bt2");
  });

  it("apply() moves the stage, records history and clears the error", async () => {
    const t = await mk();
    const moved = await store.apply(t.id, { stage: "analyzing", run: "analyzing", gate: null, note: "", error: null });
    expect(moved.stage).toBe("analyzing");
    expect(moved.history.at(-1)).toMatchObject({ stage: "analyzing", note: "" });
    const gated = await store.apply(t.id, { stage: "plan-review", run: null, gate: { kind: "plan", openedAt: "t" }, note: "n", error: null });
    expect(gated.gate).toEqual({ kind: "plan", openedAt: "t" });
    expect(gated.history.at(-1)!.note).toBe("n");
  });

  it("byAgent finds the live task for an agent and ignores terminal ones", async () => {
    const t = await mk();
    expect(store.byAgent("bugfix@payments")?.id).toBe(t.id);
    await store.apply(t.id, { stage: "done", run: null, gate: null, note: "", error: null });
    expect(store.byAgent("bugfix@payments")).toBeNull();
  });

  it("stores and reads artifacts under the task's directory", async () => {
    const t = await mk();
    await store.writeArtifact(t.id, "plan.md", "# Plan\nfix it");
    expect(await store.readArtifact(t.id, "plan.md")).toBe("# Plan\nfix it");
    expect(await store.readArtifact(t.id, "missing.md")).toBeNull();
    expect(store.dir(t.id)).toBe(path.join(home, "bugtasks", "bt1"));
  });

  it("unknown ids throw NotFound", () => {
    expect(() => store.get("nope")).toThrow(NotFound);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/store.test.ts`
Expected: FAIL — cannot find module `../../src/bugfix/store.js`.

- [ ] **Step 3: Implement the store**

`server/src/bugfix/store.ts`:

```ts
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

  private file(id: string) { return path.join(this.root, `${id}.json`); }
  dir(id: string) { return path.join(this.root, id); }

  list(): BugTask[] { return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get(id: string): BugTask {
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
      costUsd: 0, history: [{ stage: "intake", at: now, note: "" }], error: null, createdAt: now, updatedAt: now,
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
    await mkdir(this.dir(id), { recursive: true });
    await writeFile(path.join(this.dir(id), name), data);
  }
  async readArtifact(id: string, name: string): Promise<string | null> {
    return readFile(path.join(this.dir(id), name), "utf8").catch(() => null);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/bugfix/store.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 6 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/store.ts server/test/bugfix/store.test.ts
git commit -m "feat(bugfix): persistent bug task store with artifacts"
```

---

### Task 4: Git operations (worktree, guards, diff)

**Files:**
- Create: `server/src/bugfix/git.ts`
- Test: `server/test/bugfix/git.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DiffFile { path: string; additions: number; deletions: number }
  export interface DiffResult { patch: string; files: DiffFile[]; additions: number; deletions: number }
  export class GitOps {
    constructor(run?: (cwd: string, args: string[]) => Promise<string>)
    defaultBranch(repo: string): Promise<string>
    createWorktree(repo: string, branch: string, baseBranch: string): Promise<string>
    removeWorktree(repo: string, worktree: string, branch: string): Promise<void>
    currentBranch(dir: string): Promise<string>
    commitsAhead(dir: string, baseBranch: string): Promise<number>
    diff(dir: string, baseBranch: string): Promise<DiffResult>
    hasRemote(repo: string): Promise<string | null>   // origin URL or null
  }
  ```
- `worktreePath(repo, key)` → `<repo>/.worktrees/bugfix-<key>` and `branchName(key)` → `bugfix/<key>` are exported helpers.

- [ ] **Step 1: Write the failing test (real git, temp repo)**

`server/test/bugfix/git.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitOps, worktreePath, branchName } from "../../src/bugfix/git.js";

const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd }, (err, out) => (err ? rej(err) : res(String(out)))));

let repo: string; const git = new GitOps();

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "repo-"));
  await sh(repo, ["init", "-b", "main"]);
  await sh(repo, ["config", "user.email", "t@t"]); await sh(repo, ["config", "user.name", "T"]);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await sh(repo, ["add", "."]); await sh(repo, ["commit", "-m", "init"]);
});

describe("GitOps", () => {
  it("derives names and reports the default branch", async () => {
    expect(branchName("PAY-42")).toBe("bugfix/PAY-42");
    expect(worktreePath("/r", "PAY-42")).toBe("/r/.worktrees/bugfix-PAY-42");
    expect(await git.defaultBranch(repo)).toBe("main");
  });

  it("creates a worktree on a new branch, then removes it with the branch", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    expect(wt).toBe(worktreePath(repo, "PAY-42"));
    expect(await git.currentBranch(wt)).toBe("bugfix/PAY-42");
    expect(await git.commitsAhead(wt, "main")).toBe(0);
    await git.removeWorktree(repo, wt, "bugfix/PAY-42");
    expect((await sh(repo, ["worktree", "list"])).includes("bugfix-PAY-42")).toBe(false);
    expect((await sh(repo, ["branch", "--list", "bugfix/PAY-42"])).trim()).toBe("");
  });

  it("counts commits and produces a per-file diff with counts", async () => {
    const wt = await git.createWorktree(repo, "bugfix/PAY-42", "main");
    await appendFile(path.join(wt, "a.txt"), "two\nthree\n");
    await writeFile(path.join(wt, "b.txt"), "new file\n");
    await sh(wt, ["add", "."]); await sh(wt, ["commit", "-m", "fix"]);
    expect(await git.commitsAhead(wt, "main")).toBe(1);
    const d = await git.diff(wt, "main");
    expect(d.files.map(f => [f.path, f.additions, f.deletions]).sort()).toEqual([["a.txt", 2, 0], ["b.txt", 1, 0]]);
    expect(d.additions).toBe(3); expect(d.deletions).toBe(0);
    expect(d.patch).toContain("+two");
  });

  it("reports the origin remote, or null when there is none", async () => {
    expect(await git.hasRemote(repo)).toBeNull();
    await sh(repo, ["remote", "add", "origin", "git@github.com:acme/payments.git"]);
    expect(await git.hasRemote(repo)).toBe("git@github.com:acme/payments.git");
  });

  it("refuses to create a worktree for a branch that already exists", async () => {
    await git.createWorktree(repo, "bugfix/PAY-42", "main");
    await expect(git.createWorktree(repo, "bugfix/PAY-42", "main")).rejects.toThrow(/already exists/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/git.test.ts`
Expected: FAIL — cannot find module `../../src/bugfix/git.js`.

- [ ] **Step 3: Implement GitOps**

`server/src/bugfix/git.ts`:

```ts
import { execFile } from "node:child_process";
import path from "node:path";

export interface DiffFile { path: string; additions: number; deletions: number }
export interface DiffResult { patch: string; files: DiffFile[]; additions: number; deletions: number }

export const branchName = (issueKey: string) => `bugfix/${issueKey}`;
export const worktreePath = (repo: string, issueKey: string) => path.join(repo, ".worktrees", `bugfix-${issueKey}`);

const defaultRun = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? rej(new Error(String(stderr).trim() || err.message)) : res(String(stdout))));

/** Every git touch the workflow needs. Injectable runner so tests can fake git when they want to. */
export class GitOps {
  constructor(private run: (cwd: string, args: string[]) => Promise<string> = defaultRun) {}

  async defaultBranch(repo: string): Promise<string> {
    const head = await this.run(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
    const fromRemote = head.trim().replace(/^origin\//, "");
    if (fromRemote) return fromRemote;
    return (await this.run(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async createWorktree(repo: string, branch: string, baseBranch: string): Promise<string> {
    const dir = worktreePath(repo, branch.replace(/^bugfix\//, ""));
    await this.run(repo, ["worktree", "add", "-b", branch, dir, baseBranch]);
    return dir;
  }

  async removeWorktree(repo: string, worktree: string, branch: string): Promise<void> {
    await this.run(repo, ["worktree", "remove", "--force", worktree]).catch(() => {});
    await this.run(repo, ["worktree", "prune"]).catch(() => {});
    await this.run(repo, ["branch", "-D", branch]).catch(() => {});
  }

  async currentBranch(dir: string): Promise<string> {
    return (await this.run(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async commitsAhead(dir: string, baseBranch: string): Promise<number> {
    const out = await this.run(dir, ["rev-list", "--count", `${baseBranch}..HEAD`]);
    return Number(out.trim()) || 0;
  }

  /** Diff of the task branch against its base, with per-file counts for the diff card. */
  async diff(dir: string, baseBranch: string): Promise<DiffResult> {
    const range = `${baseBranch}...HEAD`;
    const patch = await this.run(dir, ["diff", range]);
    const numstat = await this.run(dir, ["diff", "--numstat", range]);
    const files: DiffFile[] = [];
    for (const line of numstat.split("\n")) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push({ path: m[3], additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 });
    }
    return { patch, files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0) };
  }

  async hasRemote(repo: string): Promise<string | null> {
    const out = await this.run(repo, ["remote", "get-url", "origin"]).catch(() => "");
    return out.trim() || null;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/bugfix/git.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 5 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/git.ts server/test/bugfix/git.test.ts
git commit -m "feat(bugfix): git worktree, branch and diff operations"
```

---

### Task 5: Integrations config and forge detection

**Files:**
- Create: `server/src/bugfix/integrations.ts`
- Test: `server/test/bugfix/integrations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TrackerConfig { preset: string; toolPrefix: string; mcpServers: Record<string, unknown>; hints?: string }
  export interface ForgeConfig { preset: "github" | "gitlab" | "custom"; getPr?: string; merge?: string; map?: Record<string, string> }
  export interface Integrations { tracker?: TrackerConfig; forge?: ForgeConfig; projectRepos: Record<string, string> }
  export class IntegrationsStore {
    constructor(home: string)
    read(): Promise<Integrations>
    write(patch: Partial<Integrations>): Promise<Integrations>
    rememberRepo(project: string, repo: string): Promise<void>
    repoFor(project: string): Promise<string | undefined>
  }
  export function detectForge(remoteUrl: string | null): "github" | "gitlab" | null
  ```

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/integrations.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntegrationsStore, detectForge } from "../../src/bugfix/integrations.js";

let home: string; let store: IntegrationsStore;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "int-")); store = new IntegrationsStore(home); });

describe("detectForge", () => {
  it("recognises github and gitlab remotes in both URL forms, and nothing else", () => {
    expect(detectForge("git@github.com:acme/pay.git")).toBe("github");
    expect(detectForge("https://github.com/acme/pay")).toBe("github");
    expect(detectForge("git@gitlab.com:acme/pay.git")).toBe("gitlab");
    expect(detectForge("https://gitlab.example.com/acme/pay.git")).toBe("gitlab");
    expect(detectForge("https://bitbucket.org/acme/pay")).toBeNull();
    expect(detectForge(null)).toBeNull();
  });
});

describe("IntegrationsStore", () => {
  it("starts empty, merges patches, and round-trips through disk", async () => {
    expect(await store.read()).toEqual({ projectRepos: {} });
    await store.write({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } } });
    await store.write({ forge: { preset: "github" } });
    const again = new IntegrationsStore(home);
    expect(await again.read()).toEqual({
      projectRepos: {},
      tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } },
      forge: { preset: "github" },
    });
  });

  it("remembers the repo used per tracker project", async () => {
    expect(await store.repoFor("PAY")).toBeUndefined();
    await store.rememberRepo("PAY", "/r/payments");
    await store.rememberRepo("WEB", "/r/web");
    expect(await store.repoFor("PAY")).toBe("/r/payments");
    await store.rememberRepo("PAY", "/r/payments-v2");
    expect(await store.repoFor("PAY")).toBe("/r/payments-v2");
  });

  it("survives a corrupt file rather than throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "integrations.json"), "{ not json");
    expect(await store.read()).toEqual({ projectRepos: {} });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/integrations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/bugfix/integrations.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface TrackerConfig { preset: string; toolPrefix: string; mcpServers: Record<string, unknown>; hints?: string }
export interface ForgeConfig { preset: "github" | "gitlab" | "custom"; getPr?: string; merge?: string; map?: Record<string, string> }
export interface Integrations { tracker?: TrackerConfig; forge?: ForgeConfig; projectRepos: Record<string, string> }

/** Which forge a git remote belongs to; null means "we can't poll it" (the flow still works, manually). */
export function detectForge(remoteUrl: string | null): "github" | "gitlab" | null {
  if (!remoteUrl) return null;
  const host = remoteUrl.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").split(/[/:]/)[0]?.toLowerCase() ?? "";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab";
  return null;
}

/** `~/.agentgrid/integrations.json` — tracker/forge providers and the project→repo memory. */
export class IntegrationsStore {
  private file: string;
  constructor(private home: string) { this.file = path.join(home, "integrations.json"); }

  async read(): Promise<Integrations> {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    let parsed: Partial<Integrations> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    return { ...parsed, projectRepos: parsed.projectRepos ?? {} };
  }

  async write(patch: Partial<Integrations>): Promise<Integrations> {
    const next = { ...(await this.read()), ...patch };
    await mkdir(this.home, { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  async rememberRepo(project: string, repo: string): Promise<void> {
    const cur = await this.read();
    await this.write({ projectRepos: { ...cur.projectRepos, [project]: repo } });
  }
  async repoFor(project: string): Promise<string | undefined> {
    return (await this.read()).projectRepos[project];
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/bugfix/integrations.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 5 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/integrations.ts server/test/bugfix/integrations.test.ts
git commit -m "feat(bugfix): integrations config and forge detection"
```

---

### Task 6: Forge adapter interface and the GitHub adapter

**Files:**
- Create: `server/src/bugfix/forge/types.ts`, `server/src/bugfix/forge/github.ts`, `server/src/bugfix/forge/index.ts`
- Test: `server/test/bugfix/forge.test.ts`

**Interfaces:**
- Consumes: `PrInfo` (Task 2), `ForgeConfig` (Task 5).
- Produces:
  ```ts
  export interface CreatePrContext { title: string; bodyFile: string; base: string; head: string }
  export interface ForgeAdapter {
    readonly name: string;
    authStatus(): Promise<{ ok: boolean; message: string }>;
    /** The command string the AGENT runs during opening-pr. */
    createPrCommand(ctx: CreatePrContext): string;
    /** The server's own verification: find the PR for a branch, or null. */
    findPr(repoDir: string, branch: string): Promise<PrInfo | null>;
  }
  export function makeForge(cfg: ForgeConfig | undefined, run?: Runner): ForgeAdapter | null;
  export type Runner = (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string; code: number }>;
  ```
  Phase 2 extends this interface with `getPr`, `listReviewEvents` and `merge`; do not add them now.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/forge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeForge, type Runner } from "../../src/bugfix/forge/index.js";

/** One recorded `gh pr list` payload — the shape the adapter must survive. */
const GH_PR_LIST = JSON.stringify([{
  number: 482, url: "https://github.com/acme/pay/pull/482", state: "OPEN", isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", updatedAt: "2026-09-25T10:00:00Z",
  statusCheckRollup: [{ state: "SUCCESS" }, { state: "SUCCESS" }],
}]);

const runner = (out: Record<string, { stdout: string; code: number }>): { run: Runner; calls: string[] } => {
  const calls: string[] = [];
  return { calls, run: async (cmd, args) => { const k = [cmd, ...args].join(" "); calls.push(k);
    for (const [prefix, res] of Object.entries(out)) if (k.startsWith(prefix)) return res;
    return { stdout: "", code: 1 }; } };
};

describe("github adapter", () => {
  it("reports auth status from `gh auth status`", async () => {
    const ok = runner({ "gh auth status": { stdout: "Logged in to github.com as m", code: 0 } });
    expect(await makeForge({ preset: "github" }, ok.run)!.authStatus()).toEqual({ ok: true, message: "Logged in to github.com as m" });
    const bad = runner({ "gh auth status": { stdout: "not logged in", code: 1 } });
    expect((await makeForge({ preset: "github" }, bad.run)!.authStatus()).ok).toBe(false);
  });

  it("builds a create-PR command the agent can run verbatim", () => {
    const f = makeForge({ preset: "github" })!;
    const cmd = f.createPrCommand({ title: "PAY-42: fix retry", bodyFile: "/tmp/body.md", base: "main", head: "bugfix/PAY-42" });
    expect(cmd).toBe(`gh pr create --base 'main' --head 'bugfix/PAY-42' --title 'PAY-42: fix retry' --body-file '/tmp/body.md'`);
  });

  it("quotes shell metacharacters in the title", () => {
    const f = makeForge({ preset: "github" })!;
    expect(f.createPrCommand({ title: "it's $(broken)", bodyFile: "/b", base: "main", head: "h" }))
      .toContain(`--title 'it'\\''s $(broken)'`);
  });

  it("finds the PR for a branch and normalises it to PrInfo", async () => {
    const r = runner({ "gh pr list": { stdout: GH_PR_LIST, code: 0 } });
    const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/repo", "bugfix/PAY-42");
    expect(pr).toEqual({ number: 482, url: "https://github.com/acme/pay/pull/482", state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS", mergeable: "MERGEABLE", lastSeenEventAt: "2026-09-25T10:00:00Z" });
    expect(r.calls[0]).toContain("--head bugfix/PAY-42");
  });

  it("returns null when no PR exists and when gh fails", async () => {
    expect(await makeForge({ preset: "github" }, runner({ "gh pr list": { stdout: "[]", code: 0 } }).run)!.findPr("/r", "b")).toBeNull();
    expect(await makeForge({ preset: "github" }, runner({}).run)!.findPr("/r", "b")).toBeNull();
  });

  it("reports failing checks as FAILURE", async () => {
    const mixed = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0], statusCheckRollup: [{ state: "SUCCESS" }, { state: "FAILURE" }] }]);
    const pr = await makeForge({ preset: "github" }, runner({ "gh pr list": { stdout: mixed, code: 0 } }).run)!.findPr("/r", "b");
    expect(pr!.checks).toBe("FAILURE");
  });

  it("makeForge returns null for an unconfigured or unsupported forge", () => {
    expect(makeForge(undefined)).toBeNull();
    expect(makeForge({ preset: "custom" })).toBeNull();   // Phase 2 implements custom
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/forge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the interface and the adapter**

`server/src/bugfix/forge/types.ts`:

```ts
import type { PrInfo } from "../types.js";

export interface CreatePrContext { title: string; bodyFile: string; base: string; head: string }

/** What the workflow needs from a code-review forge. Phase 2 adds getPr/listReviewEvents/merge. */
export interface ForgeAdapter {
  readonly name: string;
  authStatus(): Promise<{ ok: boolean; message: string }>;
  /** Command string handed to the agent during `opening-pr`. */
  createPrCommand(ctx: CreatePrContext): string;
  /** The server's own check that the PR exists — never trust the agent's claim. */
  findPr(repoDir: string, branch: string): Promise<PrInfo | null>;
}

export type Runner = (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string; code: number }>;
export type { PrInfo };
```

`server/src/bugfix/forge/github.ts`:

```ts
import { shellQuote } from "../../shell.js";
import type { CreatePrContext, ForgeAdapter, PrInfo, Runner } from "./types.js";

const FIELDS = "number,url,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup";

/** Roll many check states into one: any failure wins, else pending, else success. */
function rollup(checks: Array<{ state?: string; conclusion?: string }> | undefined): string | null {
  if (!checks?.length) return null;
  const states = checks.map(c => (c.state ?? c.conclusion ?? "").toUpperCase());
  if (states.some(s => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s))) return "FAILURE";
  if (states.some(s => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(s))) return "PENDING";
  return "SUCCESS";
}

export function githubAdapter(run: Runner): ForgeAdapter {
  return {
    name: "github",
    async authStatus() {
      const r = await run("gh", ["auth", "status"]);
      return { ok: r.code === 0, message: r.stdout.trim() || "gh auth status failed" };
    },
    createPrCommand(ctx: CreatePrContext) {
      return `gh pr create --base ${shellQuote(ctx.base)} --head ${shellQuote(ctx.head)} --title ${shellQuote(ctx.title)} --body-file ${shellQuote(ctx.bodyFile)}`;
    },
    async findPr(repoDir: string, branch: string): Promise<PrInfo | null> {
      const r = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS], repoDir);
      if (r.code !== 0) return null;
      let rows: any[] = [];
      try { rows = JSON.parse(r.stdout || "[]"); } catch { return null; }
      const pr = rows[0];
      if (!pr) return null;
      return {
        number: pr.number, url: pr.url,
        state: (pr.state ?? "OPEN").toUpperCase() as PrInfo["state"],
        reviewDecision: pr.reviewDecision ?? null,
        checks: rollup(pr.statusCheckRollup),
        mergeable: pr.mergeable ?? null,
        lastSeenEventAt: pr.updatedAt ?? new Date().toISOString(),
      };
    },
  };
}
```

`server/src/bugfix/forge/index.ts`:

```ts
import { execFile } from "node:child_process";
import type { ForgeConfig } from "../integrations.js";
import { githubAdapter } from "./github.js";
import type { ForgeAdapter, Runner } from "./types.js";

export type { ForgeAdapter, CreatePrContext, Runner } from "./types.js";

const defaultRun: Runner = (cmd, args, cwd) => new Promise(res =>
  execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout) =>
    res({ stdout: String(stdout), code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number ?? 1) : 0 })));

/** null means "no pollable forge configured" — the flow still runs, the PR is just tracked by hand. */
export function makeForge(cfg: ForgeConfig | undefined, run: Runner = defaultRun): ForgeAdapter | null {
  if (cfg?.preset === "github") return githubAdapter(run);
  return null;   // gitlab + custom land in Phase 2
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/bugfix/forge.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 7 tests pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/bugfix/forge server/test/bugfix/forge.test.ts
git commit -m "feat(bugfix): forge adapter interface and GitHub implementation"
```

---

### Task 7: Tracker provider (MCP-mediated)

**Files:**
- Create: `server/src/bugfix/tracker.ts`, `server/presets/tracker/jira.md`
- Test: `server/test/bugfix/tracker.test.ts`

**Interfaces:**
- Consumes: `TrackerConfig` (Task 5); `TrackerIssue`, `IssueSummary` (Task 2).
- Produces:
  ```ts
  export type JsonRunner = (args: { prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown>; cwd: string }) => Promise<string>;
  export interface TrackerProvider {
    listMyIssues(): Promise<IssueSummary[]>;
    fetchIssue(ref: string): Promise<TrackerIssue>;
    comment(key: string, text: string): Promise<void>;
  }
  export function mcpTracker(cfg: TrackerConfig, presetsDir: string, run: JsonRunner): TrackerProvider;
  export function parseIssue(raw: string): TrackerIssue;          // throws on malformed
  export function parseIssueList(raw: string): IssueSummary[];
  export const defaultJsonRunner: JsonRunner;                     // real SDK query, structured output
  ```

**If Task 1 recorded "not verified":** implement `restTracker(cfg, fetchFn)` in this same file instead of `mcpTracker`, satisfying the identical `TrackerProvider` interface (site URL + email + API token from `integrations.json`, `GET /rest/api/3/search` and `/issue/{key}`), and keep `parseIssue`/`parseIssueList` for shape normalisation. The rest of the plan is unchanged because nothing downstream knows which implementation it holds.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/tracker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mcpTracker, parseIssue, parseIssueList } from "../../src/bugfix/tracker.js";
import type { TrackerConfig } from "../../src/bugfix/integrations.js";

const cfg: TrackerConfig = { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://x" } }, hints: "Bugs live in PAY" };
const presets = path.resolve("presets");

const runner = (reply: string) => {
  const seen: Array<{ prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown> }> = [];
  return { seen, run: async (a: { prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown>; cwd: string }) => { seen.push(a); return reply; } };
};

describe("parsers", () => {
  it("accepts a well-formed issue and fills optional fields", () => {
    const i = parseIssue(`{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High","description":"d","acceptanceCriteria":["a","b"]}`);
    expect(i).toEqual({ key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: ["a", "b"] });
    expect(parseIssue(`{"key":"P-1","title":"t","url":"u"}`)).toMatchObject({ status: "", priority: "", description: "", acceptanceCriteria: [] });
  });
  it("tolerates a fenced code block around the JSON", () => {
    expect(parseIssue("```json\n{\"key\":\"P-1\",\"title\":\"t\",\"url\":\"u\"}\n```").key).toBe("P-1");
  });
  it("throws with the raw text when the reply is not an issue", () => {
    expect(() => parseIssue("I could not find that ticket")).toThrow(/tracker returned no usable JSON/i);
    expect(() => parseIssue(`{"title":"no key"}`)).toThrow(/key/);
  });
  it("parses a list and drops malformed rows", () => {
    expect(parseIssueList(`[{"key":"A-1","title":"t","url":"u","status":"Open","priority":"Low"},{"title":"junk"}]`))
      .toEqual([{ key: "A-1", title: "t", url: "u", status: "Open", priority: "Low" }]);
    expect(parseIssueList("[]")).toEqual([]);
  });
});

describe("mcpTracker", () => {
  it("asks for my open bugs, restricted to the tracker's tools, and returns the list", async () => {
    const r = runner(`[{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High"}]`);
    const t = mcpTracker(cfg, presets, r.run);
    expect(await t.listMyIssues()).toEqual([{ key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High" }]);
    expect(r.seen[0].allowedTools).toEqual(["mcp__atlassian"]);
    expect(r.seen[0].mcpServers).toEqual({ atlassian: { type: "sse", url: "https://x" } });   // passed explicitly — inheritance is not enough
    expect(r.seen[0].prompt).toContain("assigned to me");
    expect(r.seen[0].prompt).toContain("Bugs live in PAY");   // hints are injected
  });

  it("fetches one issue by key or URL", async () => {
    const r = runner(`{"key":"PAY-42","title":"Boom","url":"https://x/PAY-42","status":"Open","priority":"High","description":"d","acceptanceCriteria":[]}`);
    const t = mcpTracker(cfg, presets, r.run);
    expect((await t.fetchIssue("https://x/browse/PAY-42")).key).toBe("PAY-42");
    expect(r.seen[0].prompt).toContain("https://x/browse/PAY-42");
  });

  it("posts a comment and does not care about the reply", async () => {
    const r = runner("done");
    await mcpTracker(cfg, presets, r.run).comment("PAY-42", "PR is up: https://gh/pr/1");
    expect(r.seen[0].prompt).toContain("PAY-42");
    expect(r.seen[0].prompt).toContain("PR is up: https://gh/pr/1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the Jira preset prompts**

`server/presets/tracker/jira.md` — three sections the loader splits on `## `:

```md
## listMyIssues
Find the bug/defect issues assigned to me that are not done (open, in progress, or ready for development).
{{hints}}

Return ONLY a JSON array, no prose, each element:
{"key":"…","title":"…","url":"…","status":"…","priority":"…"}
At most 25, most recently updated first.

## fetchIssue
Look up this issue: {{ref}}
{{hints}}

Return ONLY a JSON object, no prose:
{"key":"…","title":"…","url":"…","status":"…","priority":"…",
 "description":"the full description as plain text",
 "acceptanceCriteria":["one per bullet, [] if none"]}

## comment
Add this comment to issue {{key}}, exactly as written, then reply with the single word OK:

{{text}}
```

- [ ] **Step 4: Implement the tracker**

`server/src/bugfix/tracker.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TrackerConfig } from "./integrations.js";
import type { IssueSummary, TrackerIssue } from "./types.js";

export type JsonRunner = (args: { prompt: string; allowedTools: string[]; mcpServers: Record<string, unknown>; cwd: string }) => Promise<string>;

export interface TrackerProvider {
  listMyIssues(): Promise<IssueSummary[]>;
  fetchIssue(ref: string): Promise<TrackerIssue>;
  comment(key: string, text: string): Promise<void>;
}

/** Pull the first JSON value out of a model reply that may be fenced or padded with prose. */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`);
  const slice = body.slice(start);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Trailing prose after the JSON: walk back to the last closing bracket.
  const end = Math.max(slice.lastIndexOf("}"), slice.lastIndexOf("]"));
  if (end === -1) throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`);
  try { return JSON.parse(slice.slice(0, end + 1)); }
  catch { throw new Error(`tracker returned no usable JSON: ${raw.slice(0, 200)}`); }
}

export function parseIssue(raw: string): TrackerIssue {
  const o = extractJson(raw) as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.key !== "string" || !o.key) throw new Error(`tracker issue has no key: ${raw.slice(0, 200)}`);
  return {
    key: o.key, title: String(o.title ?? ""), url: String(o.url ?? ""),
    status: String(o.status ?? ""), priority: String(o.priority ?? ""),
    description: String(o.description ?? ""),
    acceptanceCriteria: Array.isArray(o.acceptanceCriteria) ? o.acceptanceCriteria.map(String) : [],
  };
}

export function parseIssueList(raw: string): IssueSummary[] {
  const arr = extractJson(raw);
  if (!Array.isArray(arr)) throw new Error(`tracker returned no list: ${raw.slice(0, 200)}`);
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as any).key === "string")
    .map(r => ({ key: String(r.key), title: String(r.title ?? ""), url: String(r.url ?? ""), status: String(r.status ?? ""), priority: String(r.priority ?? "") }));
}

/** Renders `presets/tracker/<preset>.md`, split into `## section` blocks with {{placeholders}}. */
async function section(presetsDir: string, preset: string, name: string, vars: Record<string, string>): Promise<string> {
  const md = await readFile(path.join(presetsDir, "tracker", `${preset}.md`), "utf8");
  const blocks = md.split(/^## /m).slice(1);
  const block = blocks.find(b => b.split("\n")[0].trim() === name);
  if (!block) throw new Error(`tracker preset ${preset} has no "${name}" section`);
  return block.split("\n").slice(1).join("\n").trim()
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** One-shot headless SDK query returning the model's final text. */
export const defaultJsonRunner: JsonRunner = async ({ prompt, allowedTools, mcpServers, cwd }) => {
  let last = "";
  // mcpServers must be passed explicitly: a 2026-09-25 spike showed settingSources alone surfaces no MCP tools.
  for await (const m of query({ prompt, options: { cwd, settingSources: ["user"], model: "claude-opus-5",
      effort: "low", maxTurns: 12, allowedTools, mcpServers: mcpServers as never,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } })) {
    if (m.type === "assistant") for (const b of (m as any).message.content) if (b.type === "text" && b.text.trim()) last = b.text;
    if (m.type === "result" && (m as any).subtype !== "success") throw new Error(`tracker query failed: ${(m as any).subtype}`);
  }
  return last;
};

/** Tracker access through whatever MCP the user has configured; prompts come from the preset file. */
export function mcpTracker(cfg: TrackerConfig, presetsDir: string, run: JsonRunner = defaultJsonRunner): TrackerProvider {
  const ask = async (name: string, vars: Record<string, string>) =>
    run({ prompt: await section(presetsDir, cfg.preset, name, { hints: cfg.hints ?? "", ...vars }),
          allowedTools: [cfg.toolPrefix], mcpServers: cfg.mcpServers, cwd: process.cwd() });
  return {
    async listMyIssues() { return parseIssueList(await ask("listMyIssues", {})); },
    async fetchIssue(ref: string) { return parseIssue(await ask("fetchIssue", { ref })); },
    async comment(key: string, text: string) { await ask("comment", { key, text }); },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && npx vitest run test/bugfix/tracker.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 7 tests pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix/tracker.ts server/presets/tracker server/test/bugfix/tracker.test.ts
git commit -m "feat(bugfix): tracker provider over MCP with preset prompts"
```

---

### Task 8: Stage prompts

**Files:**
- Create: `server/src/bugfix/prompts.ts`, `server/presets/stages/analyze.md`, `server/presets/stages/implement.md`, `server/presets/stages/open-pr.md`
- Test: `server/test/bugfix/prompts.test.ts`, `server/test/bugfix/__snapshots__/` (generated)

**Interfaces:**
- Consumes: `BugTask` (Task 2).
- Produces: `renderStagePrompt(stage, task, ctx, presetsDir): Promise<string>` where
  `ctx = { note?: string; artifactsDir: string; planPath: string; prBodyPath: string; createPrCommand?: string }`.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { renderStagePrompt } from "../../src/bugfix/prompts.js";
import type { BugTask } from "../../src/bugfix/types.js";

const presets = path.resolve("presets");
const task: BugTask = {
  id: "bt1",
  issue: { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open",
           priority: "High", description: "Steps: retry a request…", acceptanceCriteria: ["no double rotation"] },
  trackerProject: "PAY", sourceRepo: "/r/pay", worktree: "/r/pay/.worktrees/bugfix-PAY-42",
  branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@pay", stage: "analyzing", gate: null,
  mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0, history: [], error: null, createdAt: "", updatedAt: "",
};
const ctx = { artifactsDir: "/home/.agentgrid/bugtasks/bt1", planPath: "/home/.agentgrid/bugtasks/bt1/plan.md", prBodyPath: "/home/.agentgrid/bugtasks/bt1/pr-body.md" };

describe("renderStagePrompt", () => {
  it("analyze names the ticket, the worktree and the plan file it must write", async () => {
    const p = await renderStagePrompt("analyzing", task, ctx, presets);
    expect(p).toContain("PAY-42"); expect(p).toContain("Refresh token rotates twice");
    expect(p).toContain("Steps: retry a request…"); expect(p).toContain("no double rotation");
    expect(p).toContain("/r/pay/.worktrees/bugfix-PAY-42");
    expect(p).toContain("/home/.agentgrid/bugtasks/bt1/plan.md");
    expect(p).toMatchSnapshot();
  });

  it("implement forbids pushing and requires a commit on the task branch", async () => {
    const p = await renderStagePrompt("implementing", task, ctx, presets);
    expect(p).toContain("bugfix/PAY-42");
    expect(p).toMatch(/do not push/i);
    expect(p).toMatch(/commit/i);
  });

  it("open-pr hands over the exact create command and the body file", async () => {
    const p = await renderStagePrompt("opening-pr", task, { ...ctx, createPrCommand: "gh pr create --base 'main' --head 'bugfix/PAY-42' --title 't' --body-file '/b'" }, presets);
    expect(p).toContain("gh pr create --base 'main'");
    expect(p).toContain("/home/.agentgrid/bugtasks/bt1/pr-body.md");
    expect(p).toContain("git push");
  });

  it("a reviewer note from 'request changes' is carried into the next run", async () => {
    const p = await renderStagePrompt("implementing", task, { ...ctx, note: "split that function" }, presets);
    expect(p).toContain("split that function");
    expect(await renderStagePrompt("implementing", task, ctx, presets)).not.toContain("Additional instructions");
  });

  it("refuses stages that have no prompt", async () => {
    await expect(renderStagePrompt("monitoring", task, ctx, presets)).rejects.toThrow(/no prompt/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/prompts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the three stage prompts**

`server/presets/stages/analyze.md`:

```md
You are fixing a tracked bug. Work only inside {{worktree}} (a git worktree on branch {{branch}}).

## Ticket {{issueKey}} — {{issueTitle}}
{{issueUrl}}
Priority: {{issuePriority}} · Status: {{issueStatus}}

{{issueDescription}}

Acceptance criteria:
{{acceptanceCriteria}}

## Your job in this step: understand and plan. Do not change any code yet.

1. Reproduce the problem if it is cheap to do so (a failing test, a script, a log trace).
2. Read the relevant code and find the root cause — not just the symptom.
3. Write your plan to {{planPath}} with these headings:
   - Root cause
   - Fix (files and what changes in each)
   - Test strategy (how we will know it is fixed)
   - Risks and anything you are unsure about
Keep it under 400 words; the human reads this before approving.

{{note}}

Finish with a 2–3 line summary of the root cause.
```

`server/presets/stages/implement.md`:

```md
Continue the fix for {{issueKey}} in {{worktree}}, on branch {{branch}}.

The approved plan is at {{planPath}} — follow it; if reality contradicts it, say so in your summary.

1. Make the change.
2. Add or update tests that fail before your fix and pass after it.
3. Run the project's tests and make sure they pass.
4. Commit on {{branch}} with a message starting "{{issueKey}}: ".

**Do not push. Do not create a pull request.** The human reviews the diff first.

{{note}}

Finish with a 2–3 line summary: what changed, what you verified, what is left.
```

`server/presets/stages/open-pr.md`:

```md
The diff for {{issueKey}} has been approved. Open the pull request from {{worktree}}.

1. Write the PR description to {{prBodyPath}}: what the bug was, the root cause, the fix, how it was tested, and the line `Fixes {{issueUrl}}`.
2. Push the branch: `git push -u origin {{branch}}`
3. Create the PR with exactly this command:
   {{createPrCommand}}
4. Write {{artifactsDir}}/pr.json as {"number": <number>, "url": "<url>"} using the PR the command printed.

Do not merge. Do not change any code in this step.

{{note}}

Finish with one line: the PR URL.
```

- [ ] **Step 4: Implement the renderer**

`server/src/bugfix/prompts.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BugStage, BugTask } from "./types.js";

export interface StageContext {
  artifactsDir: string;
  planPath: string;
  prBodyPath: string;
  /** Verbatim command the agent must run in `opening-pr`. */
  createPrCommand?: string;
  /** Free text from a "request changes" gate. */
  note?: string;
}

const FILES: Partial<Record<BugStage, string>> = {
  analyzing: "analyze.md",
  implementing: "implement.md",
  "opening-pr": "open-pr.md",
};

/** Fill a stage prompt from `presets/stages/*.md`. Unknown placeholders render empty, never as "undefined". */
export async function renderStagePrompt(stage: BugStage, task: BugTask, ctx: StageContext, presetsDir: string): Promise<string> {
  const file = FILES[stage];
  if (!file) throw new Error(`stage ${stage} has no prompt`);
  const template = await readFile(path.join(presetsDir, "stages", file), "utf8");
  const vars: Record<string, string> = {
    issueKey: task.issue.key, issueTitle: task.issue.title, issueUrl: task.issue.url,
    issueStatus: task.issue.status, issuePriority: task.issue.priority, issueDescription: task.issue.description,
    acceptanceCriteria: task.issue.acceptanceCriteria.length ? task.issue.acceptanceCriteria.map(a => `- ${a}`).join("\n") : "- (none given)",
    worktree: task.worktree, branch: task.branch, baseBranch: task.baseBranch,
    artifactsDir: ctx.artifactsDir, planPath: ctx.planPath, prBodyPath: ctx.prBodyPath,
    createPrCommand: ctx.createPrCommand ?? "",
    note: ctx.note?.trim() ? `## Additional instructions from the reviewer\n${ctx.note.trim()}` : "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
```

- [ ] **Step 5: Run the tests (writes the snapshot)**

Run: `cd server && npx vitest run test/bugfix/prompts.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 5 tests pass, snapshot written, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/bugfix/prompts.ts server/presets/stages server/test/bugfix/prompts.test.ts server/test/bugfix/__snapshots__
git commit -m "feat(bugfix): stage prompt templates and renderer"
```

---

### Task 9: BugFixEngine

**Files:**
- Create: `server/src/bugfix/engine.ts`
- Test: `server/test/bugfix/engine.test.ts`

**Interfaces:**
- Consumes: `BugTaskStore` (3), `GitOps` + `branchName`/`worktreePath` (4), `IntegrationsStore` (5), `ForgeAdapter` (6), `TrackerProvider` (7), `renderStagePrompt` (8), and from the existing app: `Store`, `Manager`, `Assignment`.
- Produces:
  ```ts
  export interface EngineDeps {
    store: Store; bugs: BugTaskStore; manager: Manager; git: GitOps;
    integrations: IntegrationsStore; tracker: TrackerProvider; forge: ForgeAdapter | null;
    presetsDir: string; role?: string;           // role defaults to "bugfix"
  }
  export class BugFixEngine {
    constructor(deps: EngineDeps)
    /** Wire once: reacts to assignments finishing. */ attach(): void
    preflight(repo: string): Promise<{ ok: boolean; problems: string[] }>
    intake(input: { issueRef: string; repo: string; mergePolicy?: "ask" | "auto"; mergeMethod?: "squash" | "merge" | "rebase" }): Promise<BugTask>
    approve(taskId: string): Promise<BugTask>
    requestChanges(taskId: string, text: string): Promise<BugTask>
    cancel(taskId: string): Promise<BugTask>
    retry(taskId: string): Promise<BugTask>
    diffFor(taskId: string): Promise<DiffResult>
  }
  ```
- The engine advances a task by: `nextStage()` → `bugs.apply()` → if `run` is set, render the prompt and `manager.assign(agentId, prompt)`.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/engine.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { BugFixEngine } from "../../src/bugfix/engine.js";
import { GitOps } from "../../src/bugfix/git.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery, success } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TrackerIssue } from "../../src/bugfix/types.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };

/** Fake git: records calls, pretends a worktree and commits exist. */
function fakeGit(state: { commits: number }) {
  const calls: string[] = [];
  const g = new GitOps(async () => "");
  g.defaultBranch = async () => "main";
  g.hasRemote = async () => "git@github.com:acme/pay.git";
  g.createWorktree = async (repo, branch) => { calls.push(`create ${branch}`); const d = path.join(repo, ".worktrees", branch.replace("/", "-")); await mkdir(d, { recursive: true }); return d; };
  g.removeWorktree = async () => { calls.push("remove"); };
  g.currentBranch = async () => "bugfix/PAY-42";
  g.commitsAhead = async () => state.commits;
  g.diff = async () => ({ patch: "diff --git a/a b/a\n+x\n", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 });
  return { git: g, calls };
}

const forge = {
  name: "github",
  authStatus: async () => ({ ok: true, message: "ok" }),
  createPrCommand: () => "gh pr create --base 'main' --head 'bugfix/PAY-42' --title 't' --body-file '/b'",
  findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", lastSeenEventAt: "t" }),
};

let home: string; let repo: string; let store: Store; let bugs: BugTaskStore; let fake: ReturnType<typeof makeFakeQuery>;
let engine: BugFixEngine; let comments: Array<[string, string]>; let gitState: { commits: number };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "eng-home-"));
  repo = await mkdtemp(path.join(tmpdir(), "eng-repo-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  await writeFile(path.join(home, "roles", "bugfix.md"), `---\nname: bugfix\navatar: 🐞\nmodel: claude-opus-5\n---\nYou fix bugs.`);
  await store.reloadRoles();
  bugs = new BugTaskStore(home); await bugs.init();
  fake = makeFakeQuery();
  gitState = { commits: 0 };
  comments = [];
  engine = new BugFixEngine({
    store, bugs, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
    git: fakeGit(gitState).git, integrations: new IntegrationsStore(home),
    tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async (k, t) => { comments.push([k, t]); } },
    forge, presetsDir: path.resolve("presets"),
  });
  engine.attach();
});

const finishStage = async () => { fake.emit(success("done")); fake.end(); };

describe("intake", () => {
  it("creates the agent, worktree and task, remembers the repo, and starts analyzing", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    expect(t.issue.key).toBe("PAY-42");
    expect(t.branch).toBe("bugfix/PAY-42");
    expect(t.stage).toBe("analyzing");
    const agent = store.getAgent(t.agentId);
    expect(agent).toMatchObject({ role: "bugfix", displayName: "PAY-42", repo: t.worktree, state: "working" });
    expect(fake.calls[0].prompt).toContain("PAY-42");
    expect(await new IntegrationsStore(home).repoFor("PAY")).toBe(repo);
  });

  it("refuses when the repo has no remote", async () => {
    const g = fakeGit(gitState).git; g.hasRemote = async () => null;
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    await expect(e2.intake({ issueRef: "PAY-42", repo })).rejects.toThrow(/remote/i);
  });
});

describe("stage progression", () => {
  it("analyzing → plan gate once plan.md exists", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan\nroot cause");
    await finishStage();
    await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).gate).toMatchObject({ kind: "plan" });
    expect(store.getAgent(t.agentId).state).toBe("free");  // acked, ready for the next stage
  });

  it("fails the stage when the agent did not write plan.md", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await finishStage();
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/plan\.md/);
  });

  it("approving the plan runs implementing with the plan in the prompt", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    expect(bugs.get(t.id).stage).toBe("implementing");
    expect(fake.calls.at(-1)!.prompt).toContain("plan.md");
  });

  it("request-changes loops back with the note in the prompt", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.requestChanges(t.id, "cover the retry path");
    expect(bugs.get(t.id).stage).toBe("analyzing");
    expect(fake.calls.at(-1)!.prompt).toContain("cover the retry path");
  });

  it("implementing needs a commit; with one it opens the diff gate and stores the diff", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");   // 0 commits
    expect(bugs.get(t.id).error).toMatch(/no commits/i);

    gitState.commits = 1;
    await engine.retry(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    expect(await bugs.readArtifact(t.id, "diff.patch")).toContain("diff --git");
    expect(JSON.parse((await bugs.readArtifact(t.id, "diffstat.json"))!)).toMatchObject({ additions: 1, files: [{ path: "a" }] });
    expect((await engine.diffFor(t.id)).files[0].path).toBe("a");
  });

  it("approving the diff opens the PR, records it, comments on the ticket and rests in monitoring", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    await engine.approve(t.id);
    expect(fake.calls.at(-1)!.prompt).toContain("gh pr create");
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
    expect(bugs.get(t.id).pr).toMatchObject({ number: 7, url: "https://gh/pr/7" });
    expect(comments).toEqual([["PAY-42", expect.stringContaining("https://gh/pr/7")]]);
  });

  it("opening-pr fails when the forge cannot find the PR", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, findPr: async () => null } });
    e2.attach();
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await e2.approve(t.id); gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    await e2.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/no pull request/i);
  });
});

describe("cancel and guards", () => {
  it("cancel stops the task and leaves the worktree alone", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await engine.cancel(t.id);
    expect(bugs.get(t.id).stage).toBe("cancelled");
    expect(store.getAgent(t.agentId).state).not.toBe("working");
  });
  it("a failed agent assignment fails the task with the agent's error", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    fake.emit({ type: "result", subtype: "error_max_turns", num_turns: 40, total_cost_usd: 1, duration_ms: 1, is_error: true } as never);
    fake.end();
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/error_max_turns/);
  });
  it("accumulates cost across stages", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    fake.emit(success("done", 0.5)); fake.end();
    await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).costUsd).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

`server/src/bugfix/engine.ts`:

```ts
import path from "node:path";
import { Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";
import type { Manager } from "../runner/manager.js";
import type { Assignment } from "../types.js";
import { BugTaskStore } from "./store.js";
import { GitOps, branchName, worktreePath, type DiffResult } from "./git.js";
import { IntegrationsStore } from "./integrations.js";
import type { ForgeAdapter } from "./forge/index.js";
import type { TrackerProvider } from "./tracker.js";
import { renderStagePrompt } from "./prompts.js";
import { nextStage } from "./stages.js";
import { AGENT_STAGES, type BugStage, type BugTask } from "./types.js";

export interface EngineDeps {
  store: Store; bugs: BugTaskStore; manager: Manager; git: GitOps;
  integrations: IntegrationsStore; tracker: TrackerProvider; forge: ForgeAdapter | null;
  presetsDir: string; role?: string;
}

/**
 * Drives bug tasks: turns each stage into one assignment on the task's agent, verifies
 * the result itself, and hands control back to the human at every gate.
 */
export class BugFixEngine {
  private deps: EngineDeps;
  private role: string;
  /** Notes from a "request changes" gate, consumed by the next render. */
  private pendingNote = new Map<string, string>();

  constructor(deps: EngineDeps) { this.deps = deps; this.role = deps.role ?? "bugfix"; }

  /** React to assignments finishing; safe to call once at startup. */
  attach(): void {
    this.deps.store.on("event", e => {
      if (e?.type !== "assignment") return;
      const a = e.assignment as Assignment;
      if (a.state !== "done" && a.state !== "failed") return;
      void this.onAssignmentFinished(a).catch(err => console.error("[bugfix] stage handling failed", err));
    });
  }

  async preflight(repo: string): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    if (!(await this.deps.git.hasRemote(repo))) problems.push("this repo has no `origin` remote");
    if (!this.deps.forge) problems.push("no forge configured — PR creation and tracking are unavailable");
    else {
      const auth = await this.deps.forge.authStatus();
      if (!auth.ok) problems.push(`forge not authenticated: ${auth.message}`);
    }
    try { this.deps.store.getRole(this.role); } catch { problems.push(`role "${this.role}" is missing from ~/.agentgrid/roles`); }
    return { ok: problems.length === 0, problems };
  }

  async intake(input: { issueRef: string; repo: string; mergePolicy?: "ask" | "auto"; mergeMethod?: "squash" | "merge" | "rebase" }): Promise<BugTask> {
    const { git, bugs, store, tracker, integrations } = this.deps;
    if (!(await git.hasRemote(input.repo))) throw new Conflict("this repo has no `origin` remote");

    const issue = await tracker.fetchIssue(input.issueRef);
    const branch = branchName(issue.key);
    const baseBranch = await git.defaultBranch(input.repo);
    if (branch === baseBranch) throw new Conflict(`refusing to work on the default branch (${baseBranch})`);

    const worktree = await git.createWorktree(input.repo, branch, baseBranch);
    const agent = await store.createAgent({ role: this.role, repo: worktree, displayName: issue.key });
    const project = issue.key.split("-")[0] ?? issue.key;
    await integrations.rememberRepo(project, input.repo);

    const task = await bugs.create({
      issue, trackerProject: project, sourceRepo: input.repo, worktree: worktreePath(input.repo, issue.key) === worktree ? worktree : worktree,
      branch, baseBranch, agentId: agent.id,
      mergePolicy: input.mergePolicy ?? "ask", mergeMethod: input.mergeMethod ?? "squash",
    });
    return this.advance(task.id, { type: "stage-done" });
  }

  approve(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "approve" }); }
  cancel(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "cancel" }); }
  retry(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "retry" }); }
  requestChanges(taskId: string, text: string): Promise<BugTask> {
    if (!text.trim()) throw new Conflict("say what should change");
    this.pendingNote.set(taskId, text.trim());
    return this.advance(taskId, { type: "request-changes", text: text.trim() });
  }

  diffFor(taskId: string): Promise<DiffResult> {
    const t = this.deps.bugs.get(taskId);
    return this.deps.git.diff(t.worktree, t.baseBranch);
  }

  /** One transition: move the task, then run the stage's assignment if there is one. */
  private async advance(taskId: string, event: Parameters<typeof nextStage>[1]): Promise<BugTask> {
    const current = this.deps.bugs.get(taskId);
    const t = nextStage(current, event);
    let task = await this.deps.bugs.apply(taskId, t);
    if (task.stage === "cancelled" || task.stage === "failed") await this.stopAgent(task);
    if (!t.run) return task;
    try {
      task = await this.runStage(task, t.run);
    } catch (err) {
      task = await this.deps.bugs.apply(taskId, nextStage(task, { type: "stage-failed", reason: (err as Error).message }));
    }
    return task;
  }

  private async runStage(task: BugTask, stage: BugStage): Promise<BugTask> {
    const { bugs, store, manager, forge } = this.deps;
    const dir = bugs.dir(task.id);
    const ctx = {
      artifactsDir: dir, planPath: path.join(dir, "plan.md"), prBodyPath: path.join(dir, "pr-body.md"),
      note: this.pendingNote.get(task.id),
      createPrCommand: stage === "opening-pr" && forge
        ? forge.createPrCommand({ title: `${task.issue.key}: ${task.issue.title}`, bodyFile: path.join(dir, "pr-body.md"), base: task.baseBranch, head: task.branch })
        : undefined,
    };
    if (stage === "opening-pr") {
      // Guard the only stage that touches the outside world.
      if (!forge) throw new Error("no forge configured — cannot open a pull request");
      if (task.branch === task.baseBranch) throw new Error(`refusing to push the default branch (${task.baseBranch})`);
      if ((await this.deps.git.commitsAhead(task.worktree, task.baseBranch)) === 0) throw new Error("no commits to open a pull request with");
    }
    const prompt = await renderStagePrompt(stage, task, ctx, this.deps.presetsDir);
    this.pendingNote.delete(task.id);

    const agent = store.getAgent(task.agentId);
    if (agent.state !== "free") await manager.ack(task.agentId).catch(() => {});
    await manager.assign(task.agentId, prompt);
    return bugs.get(task.id);
  }

  /** An assignment finished: verify the stage's real-world effect, then advance or fail. */
  private async onAssignmentFinished(a: Assignment): Promise<void> {
    const { bugs, store, manager } = this.deps;
    const task = bugs.byAgent(a.agentId);
    if (!task || !AGENT_STAGES.includes(task.stage)) return;

    await bugs.patch(task.id, { costUsd: Number((task.costUsd + (a.costUsd ?? 0)).toFixed(4)) });
    // Carry the session forward so later stages resume the same conversation.
    const agent = store.getAgent(task.agentId);
    if (a.sessionId && !agent.resumeSessionId) await store.updateAgent(task.agentId, { resumeSessionId: a.sessionId });
    await manager.ack(task.agentId).catch(() => {});

    if (a.state === "failed") {
      await this.advance(task.id, { type: "stage-failed", reason: a.error ?? "the agent's run failed" });
      return;
    }
    try {
      await this.verify(bugs.get(task.id));
    } catch (err) {
      await this.advance(task.id, { type: "stage-failed", reason: (err as Error).message });
      return;
    }
    await this.advance(task.id, { type: "stage-done" });
  }

  /** The server's own evidence that a stage really happened. */
  private async verify(task: BugTask): Promise<void> {
    const { bugs, git, forge, tracker } = this.deps;
    if (task.stage === "analyzing") {
      const plan = await bugs.readArtifact(task.id, "plan.md");
      if (!plan?.trim()) throw new Error("the agent did not write plan.md");
      return;
    }
    if (task.stage === "implementing") {
      if ((await git.commitsAhead(task.worktree, task.baseBranch)) === 0) throw new Error("no commits on the task branch");
      const diff = await git.diff(task.worktree, task.baseBranch);
      await bugs.writeArtifact(task.id, "diff.patch", diff.patch);
      await bugs.writeArtifact(task.id, "diffstat.json", JSON.stringify({ files: diff.files, additions: diff.additions, deletions: diff.deletions }, null, 2));
      return;
    }
    if (task.stage === "opening-pr") {
      const pr = forge ? await forge.findPr(task.sourceRepo, task.branch) : null;
      if (!pr) throw new Error("no pull request found for this branch");
      await bugs.patch(task.id, { pr });
      await tracker.comment(task.issue.key, `Fix in progress — pull request: ${pr.url}`).catch(() => {});
      return;
    }
  }

  private async stopAgent(task: BugTask): Promise<void> {
    const { store, manager } = this.deps;
    const agent = store.getAgent(task.agentId);
    if (agent.state === "working" || agent.state === "waiting") await manager.cancel(task.agentId).catch(() => {});
    else if (agent.state === "done" || agent.state === "failed") await manager.ack(task.agentId).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run test/bugfix/engine.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 11 tests pass, tsc clean. If the `{ ...(engine as any).deps }` spread in two tests fails to compile, add `readonly deps` as a public field on the engine (`constructor(public readonly deps: EngineDeps)`) and use `engine.deps`.

- [ ] **Step 5: Run the whole server suite and commit**

Run: `cd server && npx vitest run`
Expected: all previous tests still pass.

```bash
git add server/src/bugfix/engine.ts server/test/bugfix/engine.test.ts
git commit -m "feat(bugfix): workflow engine driving stages, gates and verification"
```

---

### Task 10: API routes

**Files:**
- Modify: `server/src/api/app.ts`
- Test: `server/test/bugfix/api.test.ts`

**Interfaces:**
- Consumes: `BugFixEngine` (9), `BugTaskStore` (3), `IntegrationsStore` (5), `TrackerProvider` (7), `ForgeAdapter` (6).
- Produces these routes and the `AppDeps` additions
  `bugs?: { engine: BugFixEngine; store: BugTaskStore; integrations: IntegrationsStore; tracker: TrackerProvider }`:

```
GET    /api/bugtasks                    → BugTask[]
GET    /api/bugtasks/:id                → BugTask
GET    /api/bugtasks/:id/plan           → { markdown: string }
GET    /api/bugtasks/:id/diff           → { files, additions, deletions, patch }
POST   /api/bugtasks                    { issueRef, repo, mergePolicy?, mergeMethod? } → 201 BugTask
POST   /api/bugtasks/:id/approve        → BugTask
POST   /api/bugtasks/:id/request-changes { text } → BugTask
POST   /api/bugtasks/:id/cancel         → BugTask
POST   /api/bugtasks/:id/retry          → BugTask
GET    /api/bugfix/issues               → IssueSummary[]        (tracker "my open bugs")
GET    /api/bugfix/preflight?repo=…     → { ok, problems[], suggestedRepo? }
GET    /api/integrations                → Integrations
PUT    /api/integrations                { tracker?, forge? } → Integrations
```
`GridState` gains `bugTasks: BugTask[]`, and the store's `"event"` `{type:"bugtask"}` is forwarded over SSE as `change`.

- [ ] **Step 1: Write the failing test**

`server/test/bugfix/api.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { createApp } from "../../src/api/app.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery } from "../helpers/fakeQuery.js";
import type { BugTask, TrackerIssue } from "../../src/bugfix/types.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
let app: ReturnType<typeof createApp>; let bugs: BugTaskStore; let calls: string[]; let home: string;

/** A stand-in engine: records what the routes asked for, mutates the store just enough. */
const fakeEngine = (bugs: BugTaskStore, calls: string[]) => ({
  preflight: async (repo: string) => { calls.push(`preflight ${repo}`); return { ok: true, problems: [] }; },
  intake: async (input: { issueRef: string; repo: string }) => { calls.push(`intake ${input.issueRef}`);
    return bugs.create({ issue: ISSUE, trackerProject: "PAY", sourceRepo: input.repo, worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@w", mergePolicy: "ask", mergeMethod: "squash" }); },
  approve: async (id: string) => { calls.push(`approve ${id}`); return bugs.get(id); },
  requestChanges: async (id: string, text: string) => { calls.push(`changes ${id} ${text}`); return bugs.get(id); },
  cancel: async (id: string) => { calls.push(`cancel ${id}`); return bugs.get(id); },
  retry: async (id: string) => { calls.push(`retry ${id}`); return bugs.get(id); },
  diffFor: async (id: string) => { calls.push(`diff ${id}`); return { patch: "p", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 }; },
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "api-"));
  const store = new Store(home, path.resolve("roles")); await store.init();
  bugs = new BugTaskStore(home); await bugs.init();
  calls = [];
  app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }),
    bugs: { engine: fakeEngine(bugs, calls) as never, store: bugs, integrations: new IntegrationsStore(home),
            tracker: { listMyIssues: async () => [{ key: "PAY-42", title: "Boom", url: "u", status: "Open", priority: "High" }], fetchIssue: async () => ISSUE, comment: async () => {} } } });
});

describe("bug task routes", () => {
  it("creates a task and lists it, and exposes it in /api/state", async () => {
    await request(app).post("/api/bugtasks").send({ repo: "/r" }).expect(400);              // issueRef required
    const res = await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" }).expect(201);
    expect(res.body).toMatchObject({ id: "bt1", stage: "intake" });
    expect(calls).toContain("intake PAY-42");
    expect((await request(app).get("/api/bugtasks").expect(200)).body.map((t: BugTask) => t.id)).toEqual(["bt1"]);
    expect((await request(app).get("/api/state").expect(200)).body.bugTasks).toHaveLength(1);
    await request(app).get("/api/bugtasks/nope").expect(404);
  });

  it("serves the plan markdown and the computed diff", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    expect((await request(app).get("/api/bugtasks/bt1/plan").expect(200)).body).toEqual({ markdown: "" });
    await bugs.writeArtifact("bt1", "plan.md", "# Plan\nfix");
    expect((await request(app).get("/api/bugtasks/bt1/plan").expect(200)).body.markdown).toContain("# Plan");
    const d = await request(app).get("/api/bugtasks/bt1/diff").expect(200);
    expect(d.body).toMatchObject({ additions: 1, files: [{ path: "a" }] });
    expect(calls).toContain("diff bt1");
  });

  it("routes the gate actions to the engine", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    await request(app).post("/api/bugtasks/bt1/approve").expect(200);
    await request(app).post("/api/bugtasks/bt1/request-changes").send({ text: "" }).expect(400);
    await request(app).post("/api/bugtasks/bt1/request-changes").send({ text: "redo it" }).expect(200);
    await request(app).post("/api/bugtasks/bt1/cancel").expect(200);
    await request(app).post("/api/bugtasks/bt1/retry").expect(200);
    expect(calls).toEqual(expect.arrayContaining(["approve bt1", "changes bt1 redo it", "cancel bt1", "retry bt1"]));
  });

  it("lists my issues and runs preflight", async () => {
    expect((await request(app).get("/api/bugfix/issues").expect(200)).body[0].key).toBe("PAY-42");
    expect((await request(app).get("/api/bugfix/preflight").query({ repo: "/r" }).expect(200)).body).toEqual({ ok: true, problems: [] });
    await request(app).get("/api/bugfix/preflight").expect(400);
  });

  it("reads and writes integrations", async () => {
    expect((await request(app).get("/api/integrations").expect(200)).body).toEqual({ projectRepos: {} });
    const saved = await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect(saved.body.forge).toEqual({ preset: "github" });
    expect((await request(app).get("/api/integrations")).body.forge).toEqual({ preset: "github" });
  });

  it("returns 501 for every bug route when the feature is not wired", async () => {
    const store = new Store(home, path.resolve("roles")); await store.init();
    const bare = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }) });
    await request(bare).get("/api/bugtasks").expect(501);
    await request(bare).post("/api/bugtasks").send({ issueRef: "x", repo: "/r" }).expect(501);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/api.test.ts`
Expected: FAIL — 404s, because the routes don't exist.

- [ ] **Step 3: Add the routes**

In `server/src/api/app.ts`, extend the imports and `AppDeps`:

```ts
import type { BugFixEngine } from "../bugfix/engine.js";
import type { BugTaskStore } from "../bugfix/store.js";
import type { IntegrationsStore } from "../bugfix/integrations.js";
import type { TrackerProvider } from "../bugfix/tracker.js";
```

```ts
  /** Bug-fix workflow; absent when the feature is not configured (routes answer 501). */
  bugs?: { engine: BugFixEngine; store: BugTaskStore; integrations: IntegrationsStore; tracker: TrackerProvider };
```

Then, next to the other route registrations, add:

```ts
  class NotWired extends Error { status = 501; }
  const bugs = () => { if (!deps.bugs) throw new NotWired("the bug-fix workflow is not configured"); return deps.bugs; };

  app.get("/api/bugtasks", wrap((_req, res) => res.json(bugs().store.list())));
  app.get("/api/bugtasks/:id", wrap((req, res) => res.json(bugs().store.get(req.params.id as string))));
  app.get("/api/bugtasks/:id/plan", wrap(async (req, res) => {
    const b = bugs(); b.store.get(req.params.id as string);
    res.json({ markdown: (await b.store.readArtifact(req.params.id as string, "plan.md")) ?? "" });
  }));
  app.get("/api/bugtasks/:id/diff", wrap(async (req, res) => {
    const b = bugs(); b.store.get(req.params.id as string);
    res.json(await b.engine.diffFor(req.params.id as string));
  }));
  app.post("/api/bugtasks", wrap(async (req, res) => {
    const { issueRef, repo, mergePolicy, mergeMethod } = req.body ?? {};
    if (typeof issueRef !== "string" || !issueRef.trim()) throw new BadRequest("issueRef is required");
    if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new BadRequest("an absolute repo path is required");
    res.status(201).json(await bugs().engine.intake({ issueRef: issueRef.trim(), repo, mergePolicy, mergeMethod }));
  }));
  app.post("/api/bugtasks/:id/approve", wrap(async (req, res) => res.json(await bugs().engine.approve(req.params.id as string))));
  app.post("/api/bugtasks/:id/cancel", wrap(async (req, res) => res.json(await bugs().engine.cancel(req.params.id as string))));
  app.post("/api/bugtasks/:id/retry", wrap(async (req, res) => res.json(await bugs().engine.retry(req.params.id as string))));
  app.post("/api/bugtasks/:id/request-changes", wrap(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) throw new BadRequest("text is required");
    res.json(await bugs().engine.requestChanges(req.params.id as string, text));
  }));
  app.get("/api/bugfix/issues", wrap(async (_req, res) => res.json(await bugs().tracker.listMyIssues())));
  app.get("/api/bugfix/preflight", wrap(async (req, res) => {
    const repo = req.query.repo;
    if (typeof repo !== "string" || !repo) throw new BadRequest("repo is required");
    res.json(await bugs().engine.preflight(repo));
  }));
  app.get("/api/integrations", wrap(async (_req, res) => res.json(await bugs().integrations.read())));
  app.put("/api/integrations", wrap(async (req, res) => res.json(await bugs().integrations.write(req.body ?? {}))));
```

- [ ] **Step 4: Put bug tasks into the snapshot and the SSE stream**

In `server/src/store/store.ts`, add a pluggable source so `Store` stays the single snapshot owner:

```ts
  /** Supplied by the server when the bug-fix workflow is wired. */
  bugTasks: () => unknown[] = () => [];
```
and include it in `getState()`: `return { …, bugTasks: this.bugTasks() };`

In `server/src/types.ts` add to `GridState`: `bugTasks: BugTask[];` (import the type from `./bugfix/types.js`) and extend `GridEvent` with `| { type: "bugtask"; task: BugTask }`.

In `server/src/start.ts` (Task 12 wires the rest): `store.bugTasks = () => bugTaskStore.list();` and forward the store's events:
```ts
  bugTaskStore.on("event", e => store.emit("event", e));
```

- [ ] **Step 5: Run the tests**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: the 6 new API tests pass and the whole server suite is green.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/app.ts server/src/store/store.ts server/src/types.ts server/test/bugfix/api.test.ts
git commit -m "feat(bugfix): REST routes for bug tasks, issues, preflight and integrations"
```

---

### Task 11: UI state and API client

**Files:**
- Modify: `ui/src/api.ts`, `ui/src/state/reducer.ts`
- Test: `ui/test/reducer.test.ts` (append)

**Interfaces:**
- Consumes: `BugTask`, `IssueSummary`, `Integrations` (server types, re-exported through `ui/src/types.ts` which already does `export type * from "../../server/src/types.js"` — add `export type * from "../../server/src/bugfix/types.js";` and `export type { Integrations } from "../../server/src/bugfix/integrations.js";`).
- Produces:
  - `UiState.bugTasks: Record<string, BugTask>` fed by the snapshot and `{type:"bugtask"}` events.
  - `bugTaskFor(s, agent): BugTask | null` — the live task of a bug agent.
  - api: `listBugTasks`, `createBugTask`, `bugPlan`, `bugDiff`, `approveBug`, `requestBugChanges`, `cancelBug`, `retryBug`, `myIssues`, `bugPreflight`, `getIntegrations`, `putIntegrations`.

- [ ] **Step 1: Write the failing reducer test**

Append to `ui/test/reducer.test.ts`:

```ts
describe("bug tasks", () => {
  const bt = (id: string, agentId: string, stage: string): any => ({ id, agentId, stage, issue: { key: "PAY-1", title: "t", url: "u", status: "", priority: "", description: "", acceptanceCriteria: [] }, gate: null, history: [] });
  it("snapshot fills bugTasks and events upsert them", () => {
    let s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [agent("a")], assignments: [], liveSessions: [], sessionStatuses: [], bugTasks: [bt("bt1", "a", "analyzing")] } });
    expect(bugTaskFor(s, agent("a"))?.id).toBe("bt1");
    s = reducer(s, { type: "change", event: { type: "bugtask", task: bt("bt1", "a", "plan-review") } });
    expect(bugTaskFor(s, agent("a"))?.stage).toBe("plan-review");
    expect(bugTaskFor(s, agent("other"))).toBeNull();
  });
  it("ignores tasks that have finished, so a reused agent looks clean", () => {
    const s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [agent("a")], assignments: [], liveSessions: [], sessionStatuses: [], bugTasks: [bt("bt1", "a", "done"), bt("bt2", "a", "cancelled")] } });
    expect(bugTaskFor(s, agent("a"))).toBeNull();
  });
});
```
Add `bugTaskFor` to the existing import from `../src/state/reducer`, and add `bugTasks: []` to every other `snapshot` fixture in this file.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run test/reducer.test.ts`
Expected: FAIL — `bugTaskFor` is not exported.

- [ ] **Step 3: Implement**

In `ui/src/state/reducer.ts`:

```ts
// in UiState
  bugTasks: Record<string, BugTask>;
// in initial
  bugTasks: {},
// in the snapshot branch
  bugTasks: Object.fromEntries((a.state.bugTasks ?? []).map(t => [t.id, t])),
// in the change branch, next to the other event kinds
  if (e.type === "bugtask") return { ...s, bugTasks: { ...s.bugTasks, [e.task.id]: e.task } };
```

and at the bottom:

```ts
const FINISHED_BUG_STAGES = ["done", "cancelled"];
/** The bug task an agent is currently working, if any. */
export const bugTaskFor = (s: UiState, agent: Agent): BugTask | null =>
  Object.values(s.bugTasks).find(t => t.agentId === agent.id && !FINISHED_BUG_STAGES.includes(t.stage)) ?? null;
```

In `ui/src/api.ts` add:

```ts
  listBugTasks: () => call<BugTask[]>("GET", "/api/bugtasks"),
  createBugTask: (input: { issueRef: string; repo: string; mergePolicy?: "ask" | "auto"; mergeMethod?: string }) => call<BugTask>("POST", "/api/bugtasks", input),
  bugPlan: (id: string) => call<{ markdown: string }>("GET", `/api/bugtasks/${encodeURIComponent(id)}/plan`),
  bugDiff: (id: string) => call<{ patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }>("GET", `/api/bugtasks/${encodeURIComponent(id)}/diff`),
  approveBug: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/approve`),
  requestBugChanges: (id: string, text: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/request-changes`, { text }),
  cancelBug: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/cancel`),
  retryBug: (id: string) => call<BugTask>("POST", `/api/bugtasks/${encodeURIComponent(id)}/retry`),
  myIssues: () => call<IssueSummary[]>("GET", "/api/bugfix/issues"),
  bugPreflight: (repo: string) => call<{ ok: boolean; problems: string[] }>("GET", `/api/bugfix/preflight?repo=${encodeURIComponent(repo)}`),
  getIntegrations: () => call<Integrations>("GET", "/api/integrations"),
  putIntegrations: (patch: Partial<Integrations>) => call<Integrations>("PUT", "/api/integrations", patch),
```

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all UI tests pass (add `bugTasks: []` to any snapshot fixture the compiler complains about), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/state/reducer.ts ui/src/types.ts ui/test/reducer.test.ts
git commit -m "feat(ui): bug task state and API client"
```

---

### Task 12: Bug launcher

**Files:**
- Create: `ui/src/components/BugLauncher.tsx`
- Modify: `ui/src/components/TopBar.tsx`, `ui/src/App.tsx`, `ui/src/styles.css`
- Test: `ui/test/BugLauncher.test.tsx`

**Interfaces:**
- Consumes: `api.myIssues`, `api.bugPreflight`, `api.createBugTask`, `api.getIntegrations` (Task 11); the existing folder browser API `api.listDir`/`api.pickFolder`.
- Produces: `<BugLauncher onCreated={(task) => void} onClose={() => void} />`; TopBar gains `onFixBug: () => void` and a **🐞 Fix a bug** button.

- [ ] **Step 1: Write the failing test**

`ui/test/BugLauncher.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugLauncher } from "../src/components/BugLauncher";

const myIssues = vi.fn(async () => [{ key: "PAY-42", title: "Refresh token rotates twice", url: "u", status: "Open", priority: "High" }]);
const bugPreflight = vi.fn(async (_repo: string) => ({ ok: true, problems: [] as string[] }));
const createBugTask = vi.fn(async (i: { issueRef: string; repo: string }) => ({ id: "bt1", ...i }));
const getIntegrations = vi.fn(async () => ({ projectRepos: { PAY: "/r/payments" } }));
vi.mock("../src/api", () => ({ api: {
  myIssues: () => myIssues(), bugPreflight: (r: string) => bugPreflight(r),
  createBugTask: (i: never) => createBugTask(i), getIntegrations: () => getIntegrations(),
  pickFolder: vi.fn(async () => ({ path: "/r/picked" })),
} }));

beforeEach(() => vi.clearAllMocks());

describe("BugLauncher", () => {
  it("lists my open bugs and starts one, pre-filling the remembered repo", async () => {
    const onCreated = vi.fn();
    render(<BugLauncher onCreated={onCreated} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Refresh token rotates twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /PAY-42/ }));
    expect(screen.getByLabelText("Repo")).toHaveValue("/r/payments");     // remembered for project PAY
    await waitFor(() => expect(bugPreflight).toHaveBeenCalledWith("/r/payments"));
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "PAY-42", repo: "/r/payments", mergePolicy: "ask" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "bt1" })));
  });

  it("accepts a pasted issue URL instead of the list", async () => {
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "https://x/browse/WEB-9");
    await userEvent.clear(screen.getByLabelText("Repo"));
    await userEvent.type(screen.getByLabelText("Repo"), "/r/web");
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    expect(createBugTask).toHaveBeenCalledWith({ issueRef: "https://x/browse/WEB-9", repo: "/r/web", mergePolicy: "ask" });
  });

  it("blocks starting while preflight has problems and shows them", async () => {
    bugPreflight.mockResolvedValueOnce({ ok: false, problems: ["forge not authenticated: run gh auth login"] });
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await waitFor(() => expect(screen.getByText(/gh auth login/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start fixing" })).toBeDisabled();
  });

  it("surfaces a failed issue lookup instead of silently doing nothing", async () => {
    createBugTask.mockRejectedValueOnce(new Error("tracker returned no usable JSON"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Issue URL or key"), "PAY-42");
    await userEvent.type(screen.getByLabelText("Repo"), "/r/payments");
    await userEvent.click(screen.getByRole("button", { name: "Start fixing" }));
    await waitFor(() => expect(screen.getByText(/no usable JSON/)).toBeInTheDocument());
  });

  it("says so when the tracker is not connected", async () => {
    myIssues.mockRejectedValueOnce(new Error("the bug-fix workflow is not configured"));
    render(<BugLauncher onCreated={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/not configured/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run test/BugLauncher.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the launcher**

`ui/src/components/BugLauncher.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BugTask, IssueSummary } from "../types";

/** Start a bug-fix task: pick a ticket (list or URL), pick the repo, check preflight. */
export function BugLauncher({ onCreated, onClose }: { onCreated: (task: BugTask) => void; onClose: () => void }) {
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [issueRef, setIssueRef] = useState("");
  const [repo, setRepo] = useState("");
  const [mergePolicy, setMergePolicy] = useState<"ask" | "auto">("ask");
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.myIssues().then(setIssues).catch(e => setErr((e as Error).message)); }, []);
  useEffect(() => { api.getIntegrations().then(i => setProjectRepos(i.projectRepos ?? {})).catch(() => {}); }, []);
  useEffect(() => {
    if (!repo.trim()) { setPreflight(null); return; }
    let live = true;
    const t = setTimeout(() => { api.bugPreflight(repo.trim()).then(p => live && setPreflight(p)).catch(e => live && setErr((e as Error).message)); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repo]);

  const pickIssue = (i: IssueSummary) => {
    setIssueRef(i.key);
    const remembered = projectRepos[i.key.split("-")[0] ?? ""];
    if (remembered) setRepo(remembered);
  };

  const start = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await api.createBugTask({ issueRef: issueRef.trim(), repo: repo.trim(), mergePolicy })); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const blocked = !issueRef.trim() || !repo.trim() || busy || (preflight ? !preflight.ok : false);

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" onClick={e => e.stopPropagation()}>
        <h3>🐞 Fix a bug</h3>

        <h4>My open bugs</h4>
        {!issues && !err && <p className="hint">Loading from the tracker…</p>}
        {issues && issues.length === 0 && <p className="hint">Nothing assigned to you — paste a ticket below.</p>}
        <ul className="sessions">
          {(issues ?? []).map(i => (
            <li key={i.key}>
              <button className={`folder ${issueRef === i.key ? "repo" : ""}`} onClick={() => pickIssue(i)}>
                <b>{i.key}</b> {i.title}
              </button>
              <span className="dim">{i.priority} · {i.status}</span>
            </li>
          ))}
        </ul>

        <label>Issue URL or key
          <input value={issueRef} placeholder="PAY-42 or https://…/browse/PAY-42" onChange={e => setIssueRef(e.target.value)} /></label>
        <label>Repo
          <div className="row pathrow">
            <input value={repo} placeholder="/Users/you/project" onChange={e => setRepo(e.target.value)} />
            <button className="btn" onClick={async () => { const r = await api.pickFolder().catch(() => undefined); if (r?.path) setRepo(r.path); }}>Browse…</button>
          </div></label>
        <label>When the PR is approved
          <select value={mergePolicy} onChange={e => setMergePolicy(e.target.value as "ask" | "auto")}>
            <option value="ask">ask me before merging</option>
            <option value="auto">merge automatically</option>
          </select></label>

        {preflight && !preflight.ok && <div className="err">{preflight.problems.map(p => <div key={p}>{p}</div>)}</div>}
        {err && <div className="err">{err}</div>}
        <div className="row">
          <button className="btn p" disabled={blocked} onClick={start}>{busy ? "Starting…" : "Start fixing"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

In `ui/src/components/TopBar.tsx`, add `onFixBug: () => void` to the props and a button before *Sessions*:

```tsx
      <button className="btn" onClick={onFixBug}>🐞 Fix a bug</button>
```

In `ui/src/App.tsx`: `const [bugOpen, setBugOpen] = useState(false);`, pass `onFixBug={() => setBugOpen(true)}` to `TopBar`, extend the `escape` handler with `if (bugOpen) { setBugOpen(false); return; }` (and add `bugOpen` to the `useKeyboard` deps), and render:

```tsx
      {bugOpen && <BugLauncher onCreated={t => { setBugOpen(false); dispatch({ type: "select", id: t.agentId }); }} onClose={() => setBugOpen(false)} />}
```

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: the 5 launcher tests pass, the whole UI suite is green, build clean. If `App.test.tsx` fails on a missing api mock, add `myIssues`, `bugPreflight`, `createBugTask`, `getIntegrations` stubs to its `vi.mock("../src/api")` block.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugLauncher.tsx ui/src/components/TopBar.tsx ui/src/App.tsx ui/src/styles.css ui/test/BugLauncher.test.tsx
git commit -m "feat(ui): bug-fix launcher with issue list, repo memory and preflight"
```

---

### Task 13: Gate cards in the side panel

**Files:**
- Create: `ui/src/components/BugPanel.tsx`
- Modify: `ui/src/components/SidePanel.tsx`, `ui/src/components/AgentTile.tsx`, `ui/src/App.tsx`, `ui/src/styles.css`
- Test: `ui/test/BugPanel.test.tsx`

**Interfaces:**
- Consumes: `bugTaskFor` (11), `api.bugPlan`, `api.bugDiff`, `api.approveBug`, `api.requestBugChanges`, `api.cancelBug`, `api.retryBug`.
- Produces: `<BugPanel task={BugTask} onChanged={(t: BugTask) => void} />`; `SidePanel` takes `bugTask?: BugTask | null` and renders `BugPanel` above the usual details; `AgentTile` takes `bugStage?: string` and shows it as a chip.

- [ ] **Step 1: Write the failing test**

`ui/test/BugPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugPanel } from "../src/components/BugPanel";
import type { BugTask } from "../src/types";

const bugPlan = vi.fn(async () => ({ markdown: "# Root cause\nThe token is rotated twice." }));
const bugDiff = vi.fn(async () => ({ patch: "diff --git a/x b/x\n+added line\n", additions: 3, deletions: 1,
  files: [{ path: "src/auth/session.ts", additions: 2, deletions: 1 }, { path: "test/session.test.ts", additions: 1, deletions: 0 }] }));
const approveBug = vi.fn(async () => task("implementing"));
const requestBugChanges = vi.fn(async () => task("analyzing"));
const cancelBug = vi.fn(async () => task("cancelled"));
const retryBug = vi.fn(async () => task("implementing"));
vi.mock("../src/api", () => ({ api: { bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
  approveBug: (id: string) => approveBug(id), requestBugChanges: (id: string, t: string) => requestBugChanges(id, t),
  cancelBug: (id: string) => cancelBug(id), retryBug: (id: string) => retryBug(id) } }));

function task(stage: string, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@r",
    stage: stage as BugTask["stage"], gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0.4, history: [], error: null, createdAt: "", updatedAt: "", ...extra } as BugTask;
}

beforeEach(() => vi.clearAllMocks());

describe("BugPanel", () => {
  it("always shows the ticket and the current stage", () => {
    render(<BugPanel task={task("implementing")} onChanged={vi.fn()} />);
    expect(screen.getByText("PAY-42")).toBeInTheDocument();
    expect(screen.getByText(/Refresh token rotates twice/)).toBeInTheDocument();
    expect(screen.getByTestId("bug-stage")).toHaveTextContent("implementing");
  });

  it("plan gate renders the plan and approves it", async () => {
    const onChanged = vi.fn();
    render(<BugPanel task={task("plan-review")} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/rotated twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("request changes sends the text and needs some", async () => {
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Request changes…" }));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("What should change"), "cover the retry path");
    await userEvent.click(send);
    expect(requestBugChanges).toHaveBeenCalledWith("bt1", "cover the retry path");
  });

  it("diff gate lists files with counts, expands hunks, and creates the PR", async () => {
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("src/auth/session.ts")).toBeInTheDocument());
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("2 files");
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("+3");
    await userEvent.click(screen.getByRole("button", { name: /src\/auth\/session\.ts/ }));
    expect(screen.getByText(/\+added line/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
  });

  it("failed tasks show the error with retry and cancel", async () => {
    render(<BugPanel task={task("failed", { error: "no commits on the task branch" })} onChanged={vi.fn()} />);
    expect(screen.getByText(/no commits on the task branch/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry stage" }));
    expect(retryBug).toHaveBeenCalledWith("bt1");
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(cancelBug).toHaveBeenCalledWith("bt1");
  });

  it("monitoring shows the PR link and no gate buttons", () => {
    render(<BugPanel task={task("monitoring", { pr: { number: 7, url: "https://gh/pr/7", state: "OPEN", reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", lastSeenEventAt: "" } })} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://gh/pr/7");
    expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ui && npx vitest run test/BugPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

`ui/src/components/BugPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BugTask } from "../types";

interface DiffData { patch: string; files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number }

/** Per-file slice of a unified diff, so each file can be expanded on its own. */
function hunksFor(patch: string, file: string): string {
  const parts = patch.split(/^diff --git /m).slice(1);
  const hit = parts.find(p => p.split("\n")[0].includes(file));
  return hit ? `diff --git ${hit}`.trimEnd() : "";
}

export function BugPanel({ task, onChanged }: { task: BugTask; onChanged: (t: BugTask) => void }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const gate = task.gate?.kind;
  useEffect(() => { if (gate === "plan") api.bugPlan(task.id).then(r => setPlan(r.markdown)).catch(e => setErr((e as Error).message)); }, [gate, task.id]);
  useEffect(() => { if (gate === "diff") api.bugDiff(task.id).then(setDiff).catch(e => setErr((e as Error).message)); }, [gate, task.id]);

  const act = async (fn: () => Promise<BugTask>) => {
    setBusy(true); setErr(null);
    try { onChanged(await fn()); setAsking(false); setNote(""); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="bugpanel" data-testid="bug-panel">
      <div className="bughead">
        <a className="bugkey" href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a>
        <span className="bugtitle">{task.issue.title}</span>
      </div>
      <div className="row dim">
        <span data-testid="bug-stage" className={`chip ${task.stage}`}>{task.stage}</span>
        <span>{task.issue.priority}</span>
        <span>{task.branch}</span>
        {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">PR #{task.pr.number}</a>}
        <span style={{ marginLeft: "auto" }}>${task.costUsd.toFixed(2)}</span>
      </div>

      {err && <div className="err">{err}</div>}

      {gate === "plan" && (
        <div className="gate" data-testid="gate-plan">
          <h4>Plan</h4>
          <pre className="planmd">{plan ?? "Loading…"}</pre>
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.approveBug(task.id))}>Approve &amp; implement</button>
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {gate === "diff" && (
        <div className="gate" data-testid="gate-diff">
          <h4>Diff review</h4>
          <div className="row" data-testid="diff-summary">
            <b>{diff ? `${diff.files.length} files` : "Loading…"}</b>
            {diff && <span className="add">+{diff.additions}</span>}
            {diff && <span className="del">−{diff.deletions}</span>}
          </div>
          <ul className="difffiles">
            {(diff?.files ?? []).map(f => (
              <li key={f.path}>
                <button className="folder" onClick={() => setOpen(open === f.path ? null : f.path)}>
                  {f.path} <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </button>
                {open === f.path && <pre className="hunks">{hunksFor(diff!.patch, f.path)}</pre>}
              </li>
            ))}
          </ul>
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.approveBug(task.id))}>Create PR</button>
            <button className="btn" disabled={busy} onClick={() => setAsking(true)}>Request changes…</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {asking && (
        <form className="row" onSubmit={e => { e.preventDefault(); void act(() => api.requestBugChanges(task.id, note.trim())); }}>
          <input autoFocus aria-label="What should change" value={note} placeholder="What should change?" onChange={e => setNote(e.target.value)} />
          <button className="btn p sm" type="submit" disabled={!note.trim() || busy}>Send</button>
          <button className="btn sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
        </form>
      )}

      {task.stage === "failed" && (
        <div className="gate err" data-testid="gate-failed">
          <h4>Stage failed</h4>
          <pre className="outcome err">{task.error}</pre>
          <div className="row">
            <button className="btn p" disabled={busy} onClick={() => act(() => api.retryBug(task.id))}>Retry stage</button>
            <button className="btn d" disabled={busy} onClick={() => act(() => api.cancelBug(task.id))}>Cancel task</button>
          </div>
        </div>
      )}

      {task.stage === "monitoring" && (
        <p className="hint">PR open — tracked manually in this version. Merge it in the forge when you're ready.</p>
      )}
    </div>
  );
}
```

Styles to append to `ui/src/styles.css`:

```css
.bugpanel { border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:10px; background:#12151b; }
.bughead { display:flex; gap:8px; align-items:baseline; }
.bugkey { color:#7dd3fc; font-family:ui-monospace, monospace; font-weight:600; text-decoration:none; }
.bugtitle { font-weight:600; }
.chip { border:1px solid #2b3140; border-radius:99px; padding:1px 8px; font-size:10px; text-transform:uppercase; letter-spacing:.4px; }
.chip.plan-review, .chip.diff-review { border-color:var(--amber); color:#ffd166; }
.chip.failed { border-color:var(--red); color:#fca5a5; }
.gate { margin-top:10px; border-top:1px solid var(--line); padding-top:8px; }
.planmd { white-space:pre-wrap; background:#0f1115; border-radius:6px; padding:8px; font-size:12px; max-height:280px; overflow:auto; }
.difffiles { list-style:none; margin:6px 0 0; padding:0; }
.hunks { white-space:pre; overflow:auto; background:#0f1115; border-radius:6px; padding:8px; font-size:11px; max-height:300px; }
.add { color:#86efac; } .del { color:#fca5a5; }
```

In `ui/src/components/SidePanel.tsx`: add `bugTask?: BugTask | null` and `onBugChanged?: (t: BugTask) => void` to the props, and render it immediately after the header block in the details branch:

```tsx
      {bugTask && <BugPanel task={bugTask} onChanged={t => onBugChanged?.(t)} />}
```

In `ui/src/components/AgentTile.tsx`: add `bugStage?: string` to the props and render it next to the state ring:

```tsx
      {bugStage && <span className="chip" data-testid="tile-bug-stage">{bugStage}</span>}
```

In `ui/src/App.tsx`: pass `bugTask={selected ? bugTaskFor(s, selected) : null}`, `onBugChanged={t => dispatch({ type: "change", event: { type: "bugtask", task: t } })}` to `SidePanel`, and `bugStageFor={ag => bugTaskFor(s, ag)?.stage}` to `AgentGrid` (which forwards it to `AgentTile` as `bugStage`).

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: the 6 BugPanel tests pass, the whole UI suite is green, build clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BugPanel.tsx ui/src/components/SidePanel.tsx ui/src/components/AgentTile.tsx ui/src/components/AgentGrid.tsx ui/src/App.tsx ui/src/styles.css ui/test/BugPanel.test.tsx
git commit -m "feat(ui): bug task panel with plan and diff gate cards"
```

---

### Task 14: Wire it into the server, add the role, and an end-to-end test

**Files:**
- Modify: `server/src/start.ts`, `server/roles/` (new `bugfix.md`), `README.md`, `desktop/package.json` (version bump)
- Create: `ui/e2e/bugfix.spec.ts`
- Test: `server/test/bugfix/start.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `startServer()` wires `BugTaskStore`, `IntegrationsStore`, `makeForge`, `mcpTracker` and `BugFixEngine` into `createApp`, and `AGENTGRID_FAKE=1` substitutes fakes so the e2e can run the whole flow offline.

- [ ] **Step 1: Add the `bugfix` role**

`server/roles/bugfix.md`:

```md
---
name: bugfix
avatar: 🐞
model: claude-opus-5
effort: xhigh
permissionMode: acceptEdits
settingSources: [user, project]
allowedTools: []
maxTurns: 120
maxBudgetUsd: 8
---
You fix one tracked bug at a time, inside a git worktree that belongs to you alone.

Work in small, verifiable steps: understand the failure before changing anything, prove the fix with a test that fails without it, and keep the change as small as the bug demands. Never push, open a pull request, or merge unless the current step explicitly tells you to — a human reviews your plan and your diff first.

End every task with a 2–3 line summary: what changed, what you verified, what is left.
```

- [ ] **Step 2: Write the failing wiring test**

`server/test/bugfix/start.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../src/start.js";

describe("startServer with the bug-fix workflow", () => {
  it("exposes the bug routes in fake mode and seeds the bugfix role", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-"));
    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    try {
      const state = await (await fetch(`${running.url}/api/state`)).json();
      expect(state.roles.map((r: { name: string }) => r.name)).toContain("bugfix");
      expect(state.bugTasks).toEqual([]);
      const issues = await (await fetch(`${running.url}/api/bugfix/issues`)).json();
      expect(issues[0]).toMatchObject({ key: "FAKE-1" });                 // fake tracker
      const pre = await (await fetch(`${running.url}/api/bugfix/preflight?repo=${encodeURIComponent(home)}`)).json();
      expect(pre).toHaveProperty("ok");
    } finally { await running.close(); }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd server && npx vitest run test/bugfix/start.test.ts`
Expected: FAIL — `/api/bugfix/issues` answers 501 and `bugfix` is not in the roles.

- [ ] **Step 4: Wire it up**

In `server/src/start.ts`, after the existing `ptys`/`watcher` setup and before `createApp`:

```ts
  const bugStore = new BugTaskStore(home);
  await bugStore.init();
  store.bugTasks = () => bugStore.list();
  bugStore.on("event", e => store.emit("event", e));

  const integrations = new IntegrationsStore(home);
  const cfg = await integrations.read();
  const presetsDir = opts.presetsDir ?? path.resolve(here, "..", "presets");

  // Fake mode: a canned tracker and forge so the whole flow can be exercised without Jira or gh.
  const fakeTracker: TrackerProvider = {
    listMyIssues: async () => [{ key: "FAKE-1", title: "Fake bug for demos", url: "https://example.invalid/FAKE-1", status: "Open", priority: "High" }],
    fetchIssue: async (ref: string) => ({ key: ref.split("/").pop() || "FAKE-1", title: "Fake bug for demos", url: "https://example.invalid/FAKE-1",
      status: "Open", priority: "High", description: "A fake ticket used in fake mode.", acceptanceCriteria: ["it stops happening"] }),
    comment: async () => {},
  };
  const fakeForge = {
    name: "fake", authStatus: async () => ({ ok: true, message: "fake forge" }),
    createPrCommand: () => "echo 'fake pr created'",
    findPr: async () => ({ number: 1, url: "https://example.invalid/pr/1", state: "OPEN" as const, reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", lastSeenEventAt: new Date().toISOString() }),
  };

  const tracker = fake ? fakeTracker : (cfg.tracker ? mcpTracker(cfg.tracker, presetsDir) : null);
  const forge = fake ? fakeForge : makeForge(cfg.forge);
  const engine = tracker ? new BugFixEngine({ store, bugs: bugStore, manager, git: new GitOps(), integrations, tracker, forge, presetsDir }) : null;
  engine?.attach();
```

and pass into `createApp`: `...(engine && tracker ? { bugs: { engine, store: bugStore, integrations, tracker } } : {})`.

Add `presetsDir?: string` to `StartOptions`, and the imports for `BugTaskStore`, `IntegrationsStore`, `GitOps`, `makeForge`, `mcpTracker`, `BugFixEngine`, `TrackerProvider`.

Because the packaged desktop app ships presets as a resource, also add `"presets"` to `desktop/electron-builder.json`'s `extraResources` (`{ "from": "../server/presets", "to": "presets" }`) and pass `presetsDir: resource("presets")` from `desktop/src/main.ts` when packaged.

- [ ] **Step 5: Write the end-to-end test**

`ui/e2e/bugfix.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("bug fix: launch from the fake tracker, approve the plan, land at the diff gate", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "🐞 Fix a bug" }).click();
  const dialog = page.locator(".dialog");
  await expect(dialog.getByText("Fake bug for demos")).toBeVisible();
  await dialog.getByRole("button", { name: /FAKE-1/ }).click();
  await dialog.getByLabel("Repo").fill(process.env.AGENTGRID_E2E_REPO ?? "/tmp");
  await dialog.getByRole("button", { name: "Start fixing" }).click();

  const panel = page.getByTestId("bug-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("FAKE-1")).toBeVisible();
  await expect(page.getByTestId("bug-stage")).toContainText(/analyzing|plan-review|failed/);
});
```

Note: in fake mode the scripted agent does not write `plan.md`, so the task legitimately reaches `failed` with "the agent did not write plan.md" — the test asserts the *stage machine and UI* work, not the agent. Keep that assertion as written.

- [ ] **Step 6: Run everything**

Run:
```bash
cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit
cd ../ui && npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build && npm run e2e
```
Expected: all suites pass, including the new e2e.

- [ ] **Step 7: Document and commit**

Add to `README.md` under the numbered walkthrough:

```md
11. **🐞 Fix a bug** (top bar) turns a tracked ticket into a PR: AgentGrid pulls the issue from your tracker, an agent analyses it and writes a plan you approve, implements the fix in a private git worktree, shows you the diff, and opens the pull request — pausing for your click before anything leaves your machine. Configure your tracker (any MCP-based tracker: Jira, Linear, …) and forge (GitHub today) under Settings → Integrations.
```

```bash
git add server/src/start.ts server/roles/bugfix.md server/test/bugfix/start.test.ts ui/e2e/bugfix.spec.ts desktop/electron-builder.json desktop/src/main.ts README.md desktop/package.json
git commit -m "feat(bugfix): wire the workflow into the server, add the bugfix role and e2e"
```

---

## Self-review against the spec

- **§4.1 BugTask + artifacts** → Tasks 2, 3 (`issue.json` is implicit in the task record; `plan.md`, `diff.patch`, `diffstat.json`, `pr.json` in Tasks 8, 9).
- **§4.2 stages/gates** → Task 2 (machine), Task 9 (driving), Task 13 (cards). Phase 2 stages exist in the type but intentionally have no transitions — stated in Global Constraints.
- **§4.3 agent, worktree, session reuse** → Task 9 (`intake`, `resumeSessionId` carried in `onAssignmentFinished`), Task 14 (role).
- **§5.1 tracker** → Tasks 1 (verification), 7 (provider + presets). Settings-side *Connect tracker* UI is **deliberately deferred**: Task 11/13 read and write `integrations.json` through `/api/integrations`, and the connect flow (running `claude mcp add` and opening a terminal for `/mcp`) is Phase 2's first task — Phase 1 assumes an MCP already configured, which Task 1 sets up by hand.
- **§5.2 forge** → Task 6 (interface + GitHub; gitlab/custom are Phase 2, noted in code).
- **§6 flow table** → Task 9 covers intake…opening-pr; monitoring rests (Phase 2).
- **§7 UI** → Tasks 12 (launcher), 13 (tile chip + gate cards). Review/merge cards are Phase 2.
- **§8 safety** → Task 9 (`preflight`, default-branch and commit guards, verification), Task 2 (failure transitions), Task 13 (failure card).
- **§9 testing** → unit in Tasks 2–8, integration in 9–10, UI in 11–13, e2e in 14. The opt-in live tracker test is Task 1's spike.

**Type consistency check:** `BugTask`, `BugStage`, `Transition`, `PrInfo`, `TrackerIssue`, `IssueSummary`, `DiffResult`, `ForgeAdapter`, `TrackerProvider`, `EngineDeps` are each defined once (Tasks 2, 4, 6, 7, 9) and referenced with the same names and shapes everywhere after.
