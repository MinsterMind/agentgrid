# Bug Workflow Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One full-page screen per bug fix showing the whole pipeline, live progress, everything blocking it, and the agent's assumptions — with every piece of agent/tracker text rendered, never shown as raw markdown.

**Architecture:** The server gains one data channel — each decision-making agent stage writes `assumptions-<token>.json` into the task's artifacts dir; the engine parses it on stage completion and appends items to `BugTask.assumptions`, which streams to the UI on the existing `bugtask` event. The UI gains pure derivation (`bugView.ts`), three presentation components (`Markdown`, `DiffView`, `ErrorCard`), the gate cards extracted from `BugPanel` into `BugGates`, and a `BugScreen` reached from the top bar and `#/bugs/<id>`.

**Tech Stack:** TypeScript, Node (server, vitest), React 19 + Vite (ui, vitest + Testing Library), Playwright e2e, `react-markdown` + `remark-gfm` (new, ui only).

**Spec:** `docs/superpowers/specs/2026-10-05-bug-workflow-screen-design.md`

## Global Constraints

- Ships as **0.6.0** (`desktop/package.json`).
- New dependencies: `react-markdown` and `remark-gfm`, in `ui` only. Nothing else.
- Markdown: raw HTML disabled (no `rehype-raw`), images not loaded (alt text + link), links `target="_blank" rel="noreferrer"`.
- Assumption stages: `analyzing`, `implementing`, `review-feedback`, `rebase`. **Not** `opening-pr`.
- Assumption limits: at most **20** items per file; `text` cut to **500** chars with `…`.
- Assumption reading never fails, blocks or delays a stage; `verify()` alone decides a stage.
- Agent/ticket text is rendered as text or through `<Markdown>`; never `dangerouslySetInnerHTML`, never fed back into a prompt.
- Stage ids are never shown raw in the UI; all labels come from `stageLabel()`.
- Status is shown as icon **and** word, never colour alone.
- The app is dark-only; use the existing `:root` tokens in `ui/src/styles.css`, add no light-theme counterparts.
- Monospace only for commands, paths, branch names, commit ids and diff lines.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **An agent wraps its list as `{"assumptions": [...]}`** — the items should appear, not a "malformed" warning. Pinned in Task 1.
2. **A plan whose sections are bold lines (`**Root cause**`) instead of `#` headings** — it should still render as formatted text (whole, with the "usual sections" note), never as raw `**`. Pinned in Task 4.
3. **A task that failed during intake** (`history` = intake → failed) — the strip should mark *Intake* failed, not crash or mark nothing. Pinned in Task 4.
4. **The URL names a bug that was dismissed in another window** (`#/bugs/bt9` with no bt9) — the screen should fall back to the first bug and fix the URL, not render blank. Pinned in Task 6.
5. **The live activity line is a multi-line, markdown-heavy agent message** — Now should show one plain line, truncated, not a wall of text. Pinned in Task 4.

---

### Task 1: Assumptions model, parser and store

**Files:**
- Create: `server/src/bugfix/assumptions.ts`
- Modify: `server/src/bugfix/types.ts` (add `Assumption`, two `BugTask` fields)
- Modify: `server/src/bugfix/store.ts` (`init` normalisation, `create` defaults, new `addAssumptions`)
- Test: `server/test/bugfix/assumptions.test.ts` (new), `server/test/bugfix/store.test.ts`

**Interfaces:**
- Produces:
  - `interface Assumption { id: string; stage: BugStage; round: number; kind: "assumption" | "question"; text: string; at: string }` (types.ts)
  - `BugTask.assumptions: Assumption[]`, `BugTask.assumptionsProblem: string | null`
  - `parseAssumptions(raw: string | null, meta: { token: string; stage: BugStage; round: number; at: string }): { items: Assumption[]; problem: string | null; read: boolean }` — `read` is false only when `raw` is null (no file).
  - `BugTaskStore.addAssumptions(id: string, items: Assumption[], problem: string | null): Promise<BugTask>`
  - `export const ASSUMPTION_LIMITS = { items: 20, chars: 500 }`

- [ ] **Step 1: Write the failing parser tests**

`server/test/bugfix/assumptions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAssumptions, ASSUMPTION_LIMITS } from "../../src/bugfix/assumptions.js";

const meta = { token: "abc123", stage: "analyzing" as const, round: 0, at: "2026-10-05T10:00:00.000Z" };

describe("parseAssumptions", () => {
  it("reads a valid list, tagging each item with stage, round, time and a stable id", () => {
    const r = parseAssumptions(JSON.stringify([
      { kind: "assumption", text: "Rounding happens only at checkout." },
      { kind: "question", text: "Round refunds up or down?" },
    ]), meta);
    expect(r.problem).toBeNull();
    expect(r.read).toBe(true);
    expect(r.items).toEqual([
      { id: "abc123:0", stage: "analyzing", round: 0, kind: "assumption", text: "Rounding happens only at checkout.", at: meta.at },
      { id: "abc123:1", stage: "analyzing", round: 0, kind: "question", text: "Round refunds up or down?", at: meta.at },
    ]);
  });

  it("an empty list is a clean read with nothing in it", () => {
    expect(parseAssumptions("[]", meta)).toEqual({ items: [], problem: null, read: true });
  });

  it("no file is not a problem, and not a read", () => {
    expect(parseAssumptions(null, meta)).toEqual({ items: [], problem: null, read: false });
  });

  // Review Focus 1: models routinely wrap a list in an object.
  it("accepts a list wrapped as { assumptions: [...] }", () => {
    const r = parseAssumptions(JSON.stringify({ assumptions: [{ kind: "assumption", text: "x" }] }), meta);
    expect(r.problem).toBeNull();
    expect(r.items.map(i => i.text)).toEqual(["x"]);
  });

  it("reports text that is not JSON, naming the stage, and keeps nothing", () => {
    const r = parseAssumptions("- I assumed things", meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/analyzing/);
    expect(r.problem).toMatch(/not valid JSON/i);
  });

  it("reports JSON that is not a list", () => {
    const r = parseAssumptions(JSON.stringify({ kind: "assumption", text: "x" }), meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/not a list/i);
  });

  it("rejects the whole file when an item has an unknown kind, naming the item", () => {
    const r = parseAssumptions(JSON.stringify([{ kind: "assumption", text: "ok" }, { kind: "guess", text: "x" }]), meta);
    expect(r.items).toEqual([]);
    expect(r.problem).toMatch(/item 2/);
  });

  it("rejects an item whose text is not a non-empty string", () => {
    expect(parseAssumptions(JSON.stringify([{ kind: "question", text: 4 }]), meta).problem).toMatch(/item 1/);
    expect(parseAssumptions(JSON.stringify([{ kind: "question", text: "   " }]), meta).problem).toMatch(/item 1/);
  });

  it("keeps the first 20 items and says what was cut", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: "assumption", text: `a${i}` }));
    const r = parseAssumptions(JSON.stringify(many), meta);
    expect(r.items).toHaveLength(ASSUMPTION_LIMITS.items);
    expect(r.problem).toMatch(/21/);
  });

  it("cuts long text to 500 characters with an ellipsis and says so", () => {
    const r = parseAssumptions(JSON.stringify([{ kind: "assumption", text: "x".repeat(600) }]), meta);
    expect(r.items[0].text).toHaveLength(ASSUMPTION_LIMITS.chars);
    expect(r.items[0].text.endsWith("…")).toBe(true);
    expect(r.problem).toMatch(/shortened/i);
  });

  it("trims surrounding whitespace in text", () => {
    expect(parseAssumptions(JSON.stringify([{ kind: "assumption", text: "  x \n" }]), meta).items[0].text).toBe("x");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/assumptions.test.ts`
Expected: FAIL — cannot resolve `../../src/bugfix/assumptions.js`.

- [ ] **Step 3: Add the model to `types.ts`**

In `server/src/bugfix/types.ts`, after `IssueSummary`:

```ts
/** One thing an agent stage reported it assumed, or could not decide. Agent-written text:
 *  rendered as text, never as HTML, never fed back into a prompt. */
export interface Assumption {
  /** "<dispatch token>:<index>" — stable across re-renders, and the token groups one run's items. */
  id: string;
  stage: BugStage;
  /** `feedbackRounds` when the stage was dispatched; 0 for analyze/implement. */
  round: number;
  kind: "assumption" | "question";
  text: string;
  /** When the engine read it (ISO). */
  at: string;
}
```

In `BugTask`, after `feedbackRounds`:

```ts
  /** Everything the agent stages reported assuming or being unable to decide, oldest first.
   *  Records written before 0.6.0 normalise to [] in `BugTaskStore.init`. */
  assumptions: Assumption[];
  /** Why the last assumptions file could not be used, or null. Cleared by the next clean read. */
  assumptionsProblem: string | null;
```

- [ ] **Step 4: Implement the parser**

`server/src/bugfix/assumptions.ts`:

```ts
import type { Assumption, BugStage } from "./types.js";

export const ASSUMPTION_LIMITS = { items: 20, chars: 500 };
const KINDS = new Set(["assumption", "question"]);

/**
 * An agent stage's assumptions file → items for the task, or a one-line reason it could not be
 * used. Pure, and deliberately forgiving about packaging (a `{ assumptions: [...] }` wrapper) but
 * not about content: one bad item rejects the file, because silently dropping it would show the
 * human a list that looks complete and isn't. Never throws — reading assumptions must never be
 * the reason a stage fails.
 */
export function parseAssumptions(raw: string | null, meta: { token: string; stage: BugStage; round: number; at: string }):
  { items: Assumption[]; problem: string | null; read: boolean } {
  if (raw === null) return { items: [], problem: null, read: false };
  const where = `The ${meta.stage} stage's assumptions file`;
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { return { items: [], problem: `${where} is not valid JSON.`, read: true }; }
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { assumptions?: unknown }).assumptions)) {
    data = (data as { assumptions: unknown[] }).assumptions;
  }
  if (!Array.isArray(data)) return { items: [], problem: `${where} is not a list.`, read: true };

  for (const [i, item] of data.entries()) {
    const ok = item && typeof item === "object"
      && KINDS.has((item as { kind?: unknown }).kind as string)
      && typeof (item as { text?: unknown }).text === "string"
      && ((item as { text: string }).text).trim().length > 0;
    if (!ok) return { items: [], problem: `${where} has an unusable entry (item ${i + 1}): each needs kind "assumption" or "question" and non-empty text.`, read: true };
  }

  const notes: string[] = [];
  const kept = data.slice(0, ASSUMPTION_LIMITS.items) as Array<{ kind: Assumption["kind"]; text: string }>;
  if (data.length > kept.length) notes.push(`it listed ${data.length} items; the first ${ASSUMPTION_LIMITS.items} are shown`);
  let shortened = false;
  const items = kept.map((it, i): Assumption => {
    let text = it.text.trim();
    if (text.length > ASSUMPTION_LIMITS.chars) { text = text.slice(0, ASSUMPTION_LIMITS.chars - 1) + "…"; shortened = true; }
    return { id: `${meta.token}:${i}`, stage: meta.stage, round: meta.round, kind: it.kind, text, at: meta.at };
  });
  if (shortened) notes.push(`long entries were shortened to ${ASSUMPTION_LIMITS.chars} characters`);
  return { items, problem: notes.length ? `${where}: ${notes.join("; ")}.` : null, read: true };
}
```

- [ ] **Step 5: Run the parser tests to verify they pass**

Run: `cd server && npx vitest run test/bugfix/assumptions.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Write the failing store tests**

Append to `server/test/bugfix/store.test.ts` (inside its top-level `describe`, using that file's existing setup for a temp home and a created task — read the top of the file and reuse its helper names):

```ts
  it("a record written before 0.6.0 loads with no assumptions and no problem", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bugs-old-"));
    const s1 = new BugTaskStore(home); await s1.init();
    const t = await s1.create(INPUT);
    const file = path.join(home, "bugtasks", `${t.id}.json`);
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.assumptions; delete raw.assumptionsProblem;
    await writeFile(file, JSON.stringify(raw));
    const s2 = new BugTaskStore(home); await s2.init();
    expect(s2.get(t.id).assumptions).toEqual([]);
    expect(s2.get(t.id).assumptionsProblem).toBeNull();
  });

  it("a new task starts with no assumptions", async () => {
    const t = await store.create(INPUT);
    expect(t.assumptions).toEqual([]);
    expect(t.assumptionsProblem).toBeNull();
  });

  it("addAssumptions appends, sets the problem, and two concurrent calls both land", async () => {
    const t = await store.create(INPUT);
    const a = { id: "k:0", stage: "analyzing" as const, round: 0, kind: "assumption" as const, text: "a", at: "t" };
    const b = { ...a, id: "j:0", text: "b" };
    await Promise.all([store.addAssumptions(t.id, [a], null), store.addAssumptions(t.id, [b], "p")]);
    expect(store.get(t.id).assumptions.map(x => x.text).sort()).toEqual(["a", "b"]);
    expect(store.get(t.id).assumptionsProblem).toBe("p");
  });
```

If `store.test.ts` names its store/input differently (`bugs`, `input()` …), use its names; add missing imports (`mkdtemp`, `readFile`, `writeFile`, `tmpdir`, `path`) at the top.

- [ ] **Step 7: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/store.test.ts`
Expected: FAIL — `assumptions` undefined; `addAssumptions is not a function`.

- [ ] **Step 8: Implement in `store.ts`**

In `init`, after `t.checksRoundHead ??= null;`:

```ts
      t.assumptions ??= [];
      t.assumptionsProblem ??= null;
```

In `create`, add to the literal after `feedbackRounds: 0,`:

```ts
      assumptions: [], assumptionsProblem: null,
```

After `patch`:

```ts
  /** Append a stage's assumptions and record the read's problem (null clears it). Computed from
   *  the record *inside* the write chain, so two stages finishing back to back can't drop each
   *  other's items the way a read-then-`patch` would. */
  async addAssumptions(id: string, items: Assumption[], problem: string | null): Promise<BugTask> {
    this.get(id);
    return withWriteChain(this.file(id), () => {
      const cur = this.get(id);
      return this.save({ ...cur, assumptions: [...cur.assumptions, ...items], assumptionsProblem: problem, updatedAt: new Date().toISOString() });
    });
  }
```

Add `Assumption` to the `import type { … } from "./types.js"` line.

- [ ] **Step 9: Run server tests and typecheck**

Run: `cd server && npx vitest run test/bugfix/store.test.ts test/bugfix/assumptions.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS; no type errors. If `tsc` flags other test fixtures building a `BugTask` literal without the new fields, add `assumptions: [], assumptionsProblem: null` to those fixtures.

- [ ] **Step 10: Commit**

```bash
git add server/src/bugfix/assumptions.ts server/src/bugfix/types.ts server/src/bugfix/store.ts server/test/bugfix/
git commit -m "feat(bugfix): a task carries the assumptions its agent stages report"
```

---

### Task 2: Agent stages report assumptions; the engine collects them

**Files:**
- Modify: `server/src/bugfix/prompts.ts` (`StageContext.assumptionsPath`, `vars.assumptionsPath`)
- Modify: `server/presets/stages/analyze.md`, `implement.md`, `review-feedback.md`, `rebase.md`
- Modify: `server/src/bugfix/engine.ts` (`runStage`, `onAssignmentFinished`, new private map + method)
- Modify: `server/src/fake/agent.ts` (write assumptions in fake analyze)
- Test: `server/test/bugfix/prompts.test.ts`, `server/test/bugfix/engine.test.ts`, `server/test/fake/agent.test.ts`

**Interfaces:**
- Consumes: `parseAssumptions`, `BugTaskStore.addAssumptions` (Task 1)
- Produces: `StageContext.assumptionsPath?: string`; `export const ASSUMPTION_STAGES: BugStage[]` (engine.ts); fake agent `detectStage` returns `assumptionsPath?: string`.

- [ ] **Step 1: Write the failing prompt tests**

Append to the `describe("renderStagePrompt")` block in `server/test/bugfix/prompts.test.ts` (reuse that file's existing task/ctx fixture — read its top for names; below assumes `task` and `ctx` and `PRESETS`):

```ts
  it.each(["analyzing", "implementing", "review-feedback", "rebase"] as const)(
    "%s asks for the assumptions file at the path it is given", async stage => {
      const p = await renderStagePrompt(stage, task, { ...ctx, assumptionsPath: "/a/bt1/assumptions-abc.json" }, PRESETS);
      expect(p).toContain("/a/bt1/assumptions-abc.json");
      expect(p).toMatch(/"assumption"/);
      expect(p).toMatch(/"question"/);
      expect(p).toMatch(/empty list/i);
    });

  it("opening-pr asks for no assumptions", async () => {
    const p = await renderStagePrompt("opening-pr", task, { ...ctx, assumptionsPath: "/a/bt1/assumptions-abc.json" }, PRESETS);
    expect(p).not.toContain("assumptions-abc.json");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/prompts.test.ts`
Expected: FAIL — the path is not in the prompt.

- [ ] **Step 3: Implement prompts and presets**

`prompts.ts` — in `StageContext` add:

```ts
  /** Where this dispatch's agent writes what it assumed — unique per dispatch (engine.ts). */
  assumptionsPath?: string;
```

In `vars`, after `prBodyPath: ctx.prBodyPath,` add `assumptionsPath: ctx.assumptionsPath ?? "",`.

Append this block to **each** of `analyze.md`, `implement.md`, `review-feedback.md`, `rebase.md`, immediately **before** that file's final "Finish with …" line (keep `{{note}}` where it is):

```md
## Before you finish: what you assumed

Write {{assumptionsPath}} — a JSON list of anything in this step you decided without being told, or could not decide and worked around:

[{ "kind": "assumption", "text": "One sentence: what you assumed and why." },
 { "kind": "question", "text": "One sentence: what the human should decide." }]

Only real decisions a reviewer might want to overturn. If there are none, write an empty list: []
```

Do not add it to `open-pr.md`.

- [ ] **Step 4: Run prompt tests**

Run: `cd server && npx vitest run test/bugfix/prompts.test.ts test/fake/agent.test.ts`
Expected: PASS, including the existing "does not instruct changing code / pushing" tests. If one of those flags a line in the new block, reword that line (not the test).

- [ ] **Step 5: Write the failing engine tests**

Append to `server/test/bugfix/engine.test.ts`:

```ts
/** The assumptions path this dispatch's prompt named — the test plays the agent and writes there. */
const assumptionsPathIn = (prompt: string) => /(\S+assumptions-[a-f0-9]+\.json)/.exec(prompt)![1];

describe("assumptions", () => {
  it("records what the analyze stage reported, tagged with its stage", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), JSON.stringify([{ kind: "question", text: "Up or down?" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions).toMatchObject([{ stage: "analyzing", round: 0, kind: "question", text: "Up or down?" }]);
  });

  it("records them even when the stage fails", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), JSON.stringify([{ kind: "assumption", text: "No plan needed" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");   // no plan.md
    expect(bugs.get(t.id).assumptions.map(a => a.text)).toEqual(["No plan needed"]);
  });

  it("gives every dispatch its own file, so a later round never re-reads an earlier one", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    const first = assumptionsPathIn(fake.calls.at(-1)!.prompt);
    await writeFile(first, JSON.stringify([{ kind: "assumption", text: "first" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.requestChanges(t.id, "again");
    expect(assumptionsPathIn(fake.calls.at(-1)!.prompt)).not.toBe(first);
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions.map(a => a.text)).toEqual(["first"]);
  });

  it("a malformed file sets the problem and the stage still advances; a clean read clears it", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "not json");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toMatch(/not valid JSON/);
    await engine.requestChanges(t.id, "again");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "[]");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toBeNull();
  });

  it("no file leaves the task's assumptions and problem untouched", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions).toEqual([]);
    expect(bugs.get(t.id).assumptionsProblem).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd server && npx vitest run test/bugfix/engine.test.ts -t assumptions`
Expected: FAIL — `assumptionsPathIn` finds no path (regex returns null → TypeError).

- [ ] **Step 7: Implement in the engine**

In `engine.ts`, add `import { randomBytes } from "node:crypto";` and `import { parseAssumptions } from "./assumptions.js";`.

Near `FEEDBACK_ROUND_CAP`:

```ts
/** Agent stages that make decisions a human may want to overturn, and so report assumptions.
 *  Not `opening-pr`: it writes a PR body for a change the human has already approved. */
export const ASSUMPTION_STAGES: BugStage[] = ["analyzing", "implementing", "review-feedback", "rebase"];
```

On the class, beside `currentDispatch`:

```ts
  /** The assumptions file each task's current dispatch was told to write. In memory, like
   *  `currentDispatch`: a dispatch a restart interrupts is re-run by recovery under a new token. */
  private dispatchAssumptions = new Map<string, { token: string; stage: BugStage; round: number }>();
```

In `runStage`, replace the `ctx` construction's use by adding, **after** the `review-feedback` `feedbackRounds` patch and **before** `renderStagePrompt`:

```ts
    let assumptionsPath: string | undefined;
    if (ASSUMPTION_STAGES.includes(stage)) {
      const token = randomBytes(6).toString("hex");
      assumptionsPath = path.join(dir, `assumptions-${token}.json`);
      this.dispatchAssumptions.set(task.id, { token, stage, round: bugs.get(task.id).feedbackRounds });
    } else {
      this.dispatchAssumptions.delete(task.id);
    }
    const prompt = await renderStagePrompt(stage, task, { ...ctx, assumptionsPath }, this.deps.presetsDir);
```

(and delete the old `const prompt = await renderStagePrompt(stage, task, ctx, …)` line).

Add the method:

```ts
  /** Read what this dispatch's agent said it assumed. Never throws: assumptions are reporting,
   *  not evidence, and must never be why a stage fails. */
  private async collectAssumptions(taskId: string): Promise<void> {
    const meta = this.dispatchAssumptions.get(taskId);
    if (!meta) return;
    this.dispatchAssumptions.delete(taskId);
    try {
      const raw = await this.deps.bugs.readArtifact(taskId, `assumptions-${meta.token}.json`);
      const r = parseAssumptions(raw, { ...meta, at: new Date().toISOString() });
      if (r.read) await this.deps.bugs.addAssumptions(taskId, r.items, r.problem);
    } catch { /* a store write failing here must not take the stage down with it */ }
  }
```

In `onAssignmentFinished`, immediately after the `costUsd` patch line:

```ts
    await this.collectAssumptions(task.id);
```

- [ ] **Step 8: Make the fake agent report one of each**

In `server/src/fake/agent.ts`: add `const ASSUMPTIONS_PATH = /write (\S+assumptions-[a-f0-9]+\.json)/i;`. Change `detectStage`'s return type to `{ stage: FakeStage; planPath?: string; prBodyPath?: string; assumptionsPath?: string }` and, in its analyze branch only, return `{ stage: "analyze", planPath: plan[1], ...(ASSUMPTIONS_PATH.exec(prompt) ? { assumptionsPath: ASSUMPTIONS_PATH.exec(prompt)![1] } : {}) }`. In `fakeAgentQuery`, destructure `assumptionsPath` and in the analyze branch after writing the plan:

```ts
      if (assumptionsPath) await writeFile(assumptionsPath, JSON.stringify([
        { kind: "assumption", text: "The fake ticket's fault is confined to `fake-fix.txt`." },
        { kind: "question", text: "Should the fix also add a regression test?" },
      ]));
```

Update `server/test/fake/agent.test.ts`'s analyze expectation to `expect(detectStage(prompt)).toMatchObject({ stage: "analyze", planPath: "/a/bt1/plan.md" })` if it used `toEqual` and the rendered fixture prompt now includes an assumptions path.

- [ ] **Step 9: Run the server suite and typecheck**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add server/
git commit -m "feat(bugfix): agent stages report assumptions and questions; the engine records them"
```

---

### Task 3: Markdown and error presentation components

**Files:**
- Modify: `ui/package.json` (deps)
- Create: `ui/src/components/Markdown.tsx`, `ui/src/components/ErrorCard.tsx`
- Modify: `ui/src/styles.css` (`.md`, `.errcard`)
- Test: `ui/test/Markdown.test.tsx`, `ui/test/ErrorCard.test.tsx`

**Interfaces:**
- Produces:
  - `Markdown({ text, inline?, fileLinks? }: { text: string; inline?: boolean; fileLinks?: { files: string[]; onOpen: (path: string) => void } })`
  - `ErrorCard({ text, title? }: { text: string; title?: string })`
  - `splitError(text: string): { headline: string; details: string; commands: string[] }` (exported from ErrorCard.tsx)

- [ ] **Step 1: Install**

Run: `npm install -w ui react-markdown@^10 remark-gfm@^4`
Expected: both added to `ui/package.json` `dependencies`.

- [ ] **Step 2: Write the failing tests**

`ui/test/Markdown.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Markdown } from "../src/components/Markdown";

describe("Markdown", () => {
  it("renders headings, emphasis and code as elements, with no markdown syntax left", () => {
    const { container } = render(<Markdown text={"## Root cause\nThe **token** is `rotated` twice."} />);
    expect(screen.getByRole("heading", { name: "Root cause" })).toBeInTheDocument();
    expect(container.querySelector("strong")!.textContent).toBe("token");
    expect(container.querySelector("code")!.textContent).toBe("rotated");
    expect(container.textContent).not.toMatch(/##|\*\*|`/);
  });

  it("renders a GFM table and a task list", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("never creates elements from raw HTML in the text", () => {
    const { container } = render(<Markdown text={'<script>window.x=1</script><img src=x onerror="window.y=1"> <b>bold</b>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("does not load images; shows their alt text as a link", () => {
    const { container } = render(<Markdown text={"![diagram](https://x/d.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "diagram" })).toHaveAttribute("href", "https://x/d.png");
  });

  it("opens links in a new tab without a referrer and drops javascript: urls", () => {
    render(<Markdown text={"[ok](https://x/y) [bad](javascript:alert(1))"} />);
    const ok = screen.getByRole("link", { name: "ok" });
    expect(ok).toHaveAttribute("target", "_blank");
    expect(ok).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByRole("link", { name: "bad" })?.getAttribute("href") ?? "").not.toMatch(/javascript/);
  });

  it("inline mode renders no paragraph wrapper", () => {
    const { container } = render(<Markdown inline text={"a **b**"} />);
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });

  it("turns inline code naming a known file into a button that opens it", async () => {
    const onOpen = vi.fn();
    render(<Markdown text={"Change `src/a.ts` and `other`."} fileLinks={{ files: ["src/a.ts"], onOpen }} />);
    await userEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(onOpen).toHaveBeenCalledWith("src/a.ts");
    expect(screen.queryByRole("button", { name: "other" })).toBeNull();
  });
});
```

`ui/test/ErrorCard.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorCard, splitError } from "../src/components/ErrorCard";

const CLEANUP = "worktree removal failed: busy. Left behind: /r/.worktrees/bugfix-PAY-1 and branch bugfix/PAY-1 — clear them with: git -C /r worktree remove --force /r/.worktrees/bugfix-PAY-1 && git -C /r branch -D bugfix/PAY-1";

describe("splitError", () => {
  it("uses the first sentence as the headline and keeps the rest as details", () => {
    const r = splitError(CLEANUP);
    expect(r.headline).toBe("worktree removal failed: busy.");
    expect(r.details).toMatch(/^Left behind/);
  });
  it("uses the first line when there is no sentence break", () => {
    expect(splitError("no commits on the task branch\nmore")).toMatchObject({ headline: "no commits on the task branch", details: "more" });
  });
  it("finds the commands to copy", () => {
    expect(splitError(CLEANUP).commands).toEqual(["git -C /r worktree remove --force /r/.worktrees/bugfix-PAY-1 && git -C /r branch -D bugfix/PAY-1"]);
  });
  it("a one-liner has no details", () => {
    expect(splitError("boom")).toEqual({ headline: "boom", details: "", commands: [] });
  });
});

describe("ErrorCard", () => {
  it("shows the headline, hides details behind a disclosure, and copies a command", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<ErrorCard title="Merged, with leftovers" text={CLEANUP} />);
    expect(screen.getByText("Merged, with leftovers")).toBeInTheDocument();
    expect(screen.getByText("worktree removal failed: busy.")).toBeInTheDocument();
    expect(container.querySelector("details")!.open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^git -C \/r worktree remove/));
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ui && npx vitest run test/Markdown.test.tsx test/ErrorCard.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`ui/src/components/Markdown.tsx`:

```tsx
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The one way agent, ticket and forge text reaches the screen. Rendering, never execution:
 * raw HTML is skipped (no rehype-raw), images are not fetched (a tracking pixel in a ticket
 * would otherwise phone home from the operator's machine), and react-markdown's default URL
 * transform already neutralises `javascript:` links.
 */
export function Markdown({ text, inline, fileLinks }: {
  text: string; inline?: boolean; fileLinks?: { files: string[]; onOpen: (path: string) => void };
}) {
  const components: Components = {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer">{alt || src}</a>,
    code: ({ children, className }) => {
      const s = String(children);
      if (!className && fileLinks?.files.includes(s)) {
        return <button type="button" className="filelink" onClick={() => fileLinks.onOpen(s)}>{s}</button>;
      }
      return <code className={className}>{children}</code>;
    },
    ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
  };
  const Tag = inline ? "span" : "div";
  return <Tag className={inline ? "md md-inline" : "md"}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</ReactMarkdown></Tag>;
}
```

`ui/src/components/ErrorCard.tsx`:

```tsx
/** Commands the server's messages carry for the human to run (cleanup hints, mostly). */
const COMMAND = /\b((?:git|gh|claude|npm) [^\n]+)/g;

export function splitError(text: string): { headline: string; details: string; commands: string[] } {
  const t = text.trim();
  const [first, ...more] = t.split("\n");
  const cut = first.search(/\.\s/);
  const headline = cut > 0 ? first.slice(0, cut + 1) : first;
  const details = [cut > 0 ? first.slice(cut + 1).trim() : "", ...more].filter(Boolean).join("\n").trim();
  return { headline, details, commands: [...t.matchAll(COMMAND)].map(m => m[1].trim()) };
}

/** A failure as a message: one readable headline, the rest on request, commands one click away. */
export function ErrorCard({ text, title }: { text: string; title?: string }) {
  const { headline, details, commands } = splitError(text);
  return (
    <div className="errcard" role="alert">
      {title && <div className="errcard-title">{title}</div>}
      <div className="errcard-head">{headline}</div>
      {details && <details><summary>Details</summary><pre className="errcard-details">{details}</pre></details>}
      {commands.map(c => (
        <div key={c} className="row">
          <code className="cmd">{c}</code>
          <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(c)}>Copy</button>
        </div>
      ))}
    </div>
  );
}
```

Append to `ui/src/styles.css`:

```css
.md { line-height:1.55; color:#d7dce5; } .md > :first-child { margin-top:0; } .md > :last-child { margin-bottom:0; }
.md h1, .md h2, .md h3 { font-size:13px; margin:12px 0 4px; color:var(--fg); }
.md p { margin:6px 0; } .md ul, .md ol { margin:6px 0; padding-left:20px; }
.md code { font-family:ui-monospace, monospace; font-size:11.5px; background:#0f1115; border:1px solid var(--line); border-radius:4px; padding:0 4px; }
.md pre { background:#0f1115; border:1px solid var(--line); border-radius:6px; padding:8px; overflow:auto; } .md pre code { border:0; padding:0; }
.md table { border-collapse:collapse; margin:6px 0; } .md th, .md td { border:1px solid var(--line); padding:3px 8px; text-align:left; }
.md a { color:#93b4ff; } .md-inline { display:inline; }
.filelink { font:11.5px ui-monospace, monospace; background:#0f1115; border:1px solid #2b3140; border-radius:4px; padding:0 4px; color:#93b4ff; cursor:pointer; }
.errcard { border:1px solid #7f1d1d; background:#1f0f10; border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; }
.errcard-title { font-weight:600; color:#fecaca; } .errcard-head { color:#fca5a5; }
.errcard summary { cursor:pointer; color:var(--dim); font-size:12px; }
.errcard-details { white-space:pre-wrap; font:11.5px/1.5 ui-monospace, monospace; color:#e3b4b4; margin:6px 0 0; }
.btn.sm { padding:2px 8px; font-size:11px; }
```

(If `.btn.sm` already exists in `styles.css`, skip that last rule.)

- [ ] **Step 5: Run the tests**

Run: `cd ui && npx vitest run test/Markdown.test.tsx test/ErrorCard.test.tsx && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. If vitest fails to load react-markdown as ESM, add `server: { deps: { inline: [/react-markdown/, /remark-/, /micromark/, /mdast-/, /unist-/, /hast-/] } }` under `test` in `ui/vite.config.ts` (or the vitest config file the ui package uses) and re-run.

- [ ] **Step 6: Commit**

```bash
git add ui/package.json package-lock.json ui/src/components/Markdown.tsx ui/src/components/ErrorCard.tsx ui/src/styles.css ui/test/Markdown.test.tsx ui/test/ErrorCard.test.tsx ui/vite.config.ts
git commit -m "feat(ui): one safe markdown renderer, and errors as cards instead of dumps"
```

---

### Task 4: Pure view derivation — `bugView.ts`

**Files:**
- Create: `ui/src/bugView.ts`
- Modify: `ui/src/format.ts` (add `relativeTime`)
- Test: `ui/test/bugView.test.ts`, `ui/test/format.test.ts` (create if absent)

**Interfaces:**
- Consumes: `BugTask`, `BugStage`, `Assumption`, `Pending`, `SessionActivity`, `SetupReport` types.
- Produces (all exported from `ui/src/bugView.ts`):
  - `stageLabel(stage: BugStage): string`
  - `type StepState = "done" | "current" | "waiting" | "failed" | "cancelled" | "todo"`
  - `interface Step { id: string; label: string; state: StepState; badge?: string }`
  - `pipelineFor(task: BugTask, agentWaiting: boolean): Step[]`
  - `type ListStatus = "running" | "waiting" | "failed" | "done" | "cancelled"`
  - `listStatus(task: BugTask, agentWaiting: boolean): ListStatus`
  - `interface Now { headline: string; detail?: string; since?: string }`
  - `nowFor(input: { task: BugTask; pending: Pending | null; activity: SessionActivity | null }): Now`
  - `interface Blocker { kind: "gate" | "agent" | "failed" | "pr" | "setup" | "questions"; title: string; detail?: string }`
  - `blockersFor(input: { task: BugTask; pending: Pending | null; setup: SetupReport | null; setupError: boolean }): Blocker[]`
  - `newestToken(task: BugTask): string | null` and `isNew(a: Assumption, task: BugTask): boolean`
  - `orderAssumptions(items: Assumption[]): Assumption[]` — questions first, then by workflow stage order, then oldest first
  - `interface PlanSection { title: string; body: string }`
  - `planSections(md: string): { sections: PlanSection[]; structured: boolean }`
  - `type DiffRow = { kind: "file"; text: string } | { kind: "hunk"; context: string } | { kind: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string } | { kind: "note"; text: string }`
  - `parseHunks(patch: string): DiffRow[]`
  - `format.ts`: `relativeTime(iso: string | null, now?: number): string`

- [ ] **Step 1: Write the failing tests**

`ui/test/bugView.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AGENT_STAGES as SERVER_AGENT, GATE_STAGES as SERVER_GATE, SERVER_STAGES as SERVER_SERVER, TERMINAL_STAGES as SERVER_TERMINAL } from "../../server/src/bugfix/types";
import { AGENT_STAGES, GATE_STAGES, SERVER_STAGES, TERMINAL_STAGES, stageLabel, pipelineFor, listStatus, nowFor, blockersFor, orderAssumptions, isNew, planSections, parseHunks } from "../src/bugView";
import type { Assumption, BugStage, BugTask, SetupReport } from "../src/types";

const ALL: BugStage[] = ["intake", "analyzing", "plan-review", "implementing", "diff-review", "opening-pr", "creating-pr", "monitoring", "review-feedback", "rebase", "pushing", "approved", "merging", "done", "cancelled", "failed"];

function task(stage: BugStage, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "T", url: "https://x", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "a1", stage,
    gate: stage === "plan-review" ? { kind: "plan", openedAt: "t" } : stage === "diff-review" ? { kind: "diff", openedAt: "t" } : stage === "approved" ? { kind: "merge", openedAt: "t" } : null,
    mergePolicy: "ask", mergeMethod: "squash", approvedHead: null, outcome: null, checksRoundHead: null, pr: null, prCheckedAt: null,
    costUsd: 0, history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage, at: "2026-10-05T10:05:00Z", note: "" }],
    error: null, createdAt: "", updatedAt: "", feedbackRounds: 0, assumptions: [], assumptionsProblem: null, ...extra };
}
const A = (over: Partial<Assumption>): Assumption => ({ id: "t1:0", stage: "analyzing", round: 0, kind: "assumption", text: "x", at: "t", ...over });

describe("stage groups", () => {
  it("match the server's", () => {
    expect(AGENT_STAGES).toEqual(SERVER_AGENT); expect(GATE_STAGES).toEqual(SERVER_GATE);
    expect(SERVER_STAGES).toEqual(SERVER_SERVER); expect(TERMINAL_STAGES).toEqual(SERVER_TERMINAL);
  });
});

describe("stageLabel", () => {
  it.each(ALL)("%s has a human label that is not its id", s => {
    expect(stageLabel(s)).toBeTruthy();
    expect(stageLabel(s)).not.toBe(s);
  });
  it("reads review-feedback as Addressing review", () => expect(stageLabel("review-feedback")).toBe("Addressing review"));
});

describe("pipelineFor", () => {
  const states = (t: BugTask, w = false) => pipelineFor(t, w).map(s => s.state);
  it("has the eight steps in order", () => {
    expect(pipelineFor(task("intake"), false).map(s => s.label)).toEqual(["Intake", "Analyze", "Plan review", "Implement", "Diff review", "Open PR", "Monitor", "Merge"]);
  });
  it.each(ALL)("every stage maps to a pipeline without throwing (%s)", s => {
    expect(pipelineFor(task(s), false)).toHaveLength(8);
  });
  it("marks earlier steps done, the running one current, later ones todo", () => {
    expect(states(task("implementing"))).toEqual(["done", "done", "done", "current", "todo", "todo", "todo", "todo"]);
  });
  it("a gate is waiting on you", () => {
    expect(states(task("plan-review"))[2]).toBe("waiting");
    expect(states(task("approved"))[7]).toBe("waiting");
  });
  it("an agent waiting on a permission makes its step waiting", () => {
    expect(states(task("implementing"), true)[3]).toBe("waiting");
  });
  it("groups server stages under their step", () => {
    expect(states(task("creating-pr"))[5]).toBe("current");
    expect(states(task("rebase"))[6]).toBe("current");
  });
  it("a failure marks the step where it happened", () => {
    const t = task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "analyzing", at: "b", note: "" }, { stage: "implementing", at: "c", note: "" }, { stage: "failed", at: "d", note: "" }] });
    expect(states(t)).toEqual(["done", "done", "done", "failed", "todo", "todo", "todo", "todo"]);
  });
  // Review Focus 3.
  it("a failure during intake marks Intake failed", () => {
    const t = task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "failed", at: "b", note: "" }] });
    expect(states(t)[0]).toBe("failed");
  });
  it("cancelled marks its step cancelled", () => {
    const t = task("cancelled", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "plan-review", at: "b", note: "" }, { stage: "cancelled", at: "c", note: "" }] });
    expect(states(t)[2]).toBe("cancelled");
  });
  it("done marks every step done", () => {
    expect(states(task("done"))).toEqual(Array(8).fill("done"));
  });
  it("Monitor carries the round once there has been one", () => {
    expect(pipelineFor(task("monitoring", { feedbackRounds: 2 }), false)[6].badge).toBe("round 2");
    expect(pipelineFor(task("monitoring"), false)[6].badge).toBeUndefined();
  });
});

describe("listStatus", () => {
  it.each([["implementing", false, "running"], ["plan-review", false, "waiting"], ["implementing", true, "waiting"], ["failed", false, "failed"], ["done", false, "done"], ["cancelled", false, "cancelled"]] as const)(
    "%s (agent waiting: %s) → %s", (s, w, want) => expect(listStatus(task(s), w)).toBe(want));
});

describe("nowFor", () => {
  it("agent stage: label, since the stage began, and the agent's pending tool", () => {
    const n = nowFor({ task: task("implementing"), pending: null, activity: { sessionId: "s", phase: "working", lastMessage: "Editing", lastPrompt: "", pendingTool: { name: "Bash", summary: "npm test" }, updatedAt: "" } as never });
    expect(n).toMatchObject({ headline: "Implementing", detail: "npm test", since: "2026-10-05T10:05:00Z" });
  });
  // Review Focus 5.
  it("activity text becomes one plain, short line", () => {
    const long = "## Heading\n\n**Bold** and `code` " + "word ".repeat(80);
    const n = nowFor({ task: task("implementing"), pending: null, activity: { sessionId: "s", phase: "working", lastMessage: long, lastPrompt: "", updatedAt: "" } as never });
    expect(n.detail).not.toMatch(/\n|##|\*\*|`/);
    expect(n.detail!.length).toBeLessThanOrEqual(141);
  });
  it("a pending permission says the agent is waiting on you", () => {
    const n = nowFor({ task: task("implementing"), pending: { kind: "permission", toolUseId: "u", toolName: "Bash", input: {}, suggestions: [] }, activity: null });
    expect(n.headline).toMatch(/waiting on you/i);
    expect(n.detail).toMatch(/Bash/);
  });
  it("gates say what you need to do", () => {
    expect(nowFor({ task: task("plan-review"), pending: null, activity: null }).headline).toBe("Waiting on you: approve the plan");
    expect(nowFor({ task: task("diff-review"), pending: null, activity: null }).headline).toBe("Waiting on you: review the diff");
    expect(nowFor({ task: task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "rebase" } }), pending: null, activity: null }).headline).toMatch(/rebased/);
    expect(nowFor({ task: task("approved"), pending: null, activity: null }).headline).toBe("Waiting on you: merge the pull request");
  });
  it("server stages name AgentGrid as the actor", () => {
    expect(nowFor({ task: task("pushing"), pending: null, activity: null }).headline).toBe("AgentGrid is pushing the branch");
  });
  it("monitoring names the PR", () => {
    const pr = { number: 12, url: "u", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "" };
    expect(nowFor({ task: task("monitoring", { pr, prCheckedAt: "2026-10-05T10:00:00Z" }), pending: null, activity: null })).toMatchObject({ headline: "Watching PR #12", since: "2026-10-05T10:00:00Z" });
  });
  it("terminal stages state the outcome", () => {
    expect(nowFor({ task: task("done", { outcome: "merged" }), pending: null, activity: null }).headline).toBe("Merged");
    expect(nowFor({ task: task("done", { outcome: "closed" }), pending: null, activity: null }).headline).toBe("Closed without merging");
    expect(nowFor({ task: task("cancelled"), pending: null, activity: null }).headline).toBe("Cancelled");
  });
});

describe("blockersFor", () => {
  const base = { pending: null, setup: null, setupError: false };
  it("nothing blocking a running stage", () => expect(blockersFor({ ...base, task: task("implementing") })).toEqual([]));
  it("an open gate", () => expect(blockersFor({ ...base, task: task("plan-review") })).toEqual([{ kind: "gate", title: "Waiting on you: approve the plan" }]));
  it("a pending agent request", () => expect(blockersFor({ ...base, task: task("implementing"), pending: { kind: "question", toolUseId: "u", toolName: "AskUserQuestion", input: {}, suggestions: [] } })[0].kind).toBe("agent"));
  it("a failed stage carries its error", () => {
    const t = task("failed", { error: "no commits on the task branch", history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] });
    expect(blockersFor({ ...base, task: t })).toEqual([{ kind: "failed", title: "The Implementing stage failed", detail: "no commits on the task branch" }]);
  });
  it("PR problems while monitoring", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE", mergeable: "CONFLICTING", headSha: null, lastSeenEventAt: "" };
    expect(blockersFor({ ...base, task: task("monitoring", { pr }) }).map(b => b.title)).toEqual(["Checks are failing", "Reviewers asked for changes", "The branch conflicts with main"]);
  });
  it("an unreachable PR", () => {
    expect(blockersFor({ ...base, task: task("monitoring", { error: "could not check the pull request: timeout" }) })).toEqual([{ kind: "pr", title: "Could not check the pull request", detail: "timeout" }]);
  });
  it("blocking setup problems, and saying when setup could not be checked", () => {
    const setup = { ready: true, wired: true, addCommand: "", discovery: { servers: [], problems: [] }, checks: [
      { id: "role", state: "missing", blocks: true, detail: "The bugfix role could not be resolved." },
      { id: "forge-token", state: "missing", blocks: false, detail: "no token" },
    ] } as SetupReport;
    expect(blockersFor({ ...base, task: task("implementing"), setup })).toEqual([{ kind: "setup", title: "The bugfix role could not be resolved." }]);
    expect(blockersFor({ ...base, task: task("implementing"), setupError: true })).toEqual([{ kind: "setup", title: "Could not check setup" }]);
  });
  it("open questions from the latest run, at a gate", () => {
    const t = task("plan-review", { assumptions: [A({ id: "old:0", kind: "question" }), A({ id: "new:0", kind: "question" }), A({ id: "new:1", kind: "question" })] });
    expect(blockersFor({ ...base, task: t })).toContainEqual({ kind: "questions", title: "2 questions to answer before approving" });
  });
  it("a finished task has no setup or PR blockers", () => {
    const setup = { checks: [{ id: "role", state: "missing", blocks: true, detail: "x" }] } as unknown as SetupReport;
    expect(blockersFor({ ...base, task: task("done"), setup })).toEqual([]);
  });
});

describe("assumptions ordering and newness", () => {
  it("questions first, then workflow order, then oldest first", () => {
    const items = [A({ id: "b:0", stage: "implementing", text: "impl" }), A({ id: "a:0", stage: "analyzing", text: "an" }), A({ id: "b:1", stage: "implementing", kind: "question", text: "q" })];
    expect(orderAssumptions(items).map(i => i.text)).toEqual(["q", "an", "impl"]);
  });
  it("items from the most recent run are new", () => {
    const t = task("plan-review", { assumptions: [A({ id: "a:0" }), A({ id: "b:0" })] });
    expect(isNew(t.assumptions[0], t)).toBe(false);
    expect(isNew(t.assumptions[1], t)).toBe(true);
  });
});

describe("planSections", () => {
  it("splits a plan into its titled sections and drops a bare document title", () => {
    const r = planSections("# Plan\n\n## Root cause\nA\n\n## Fix\nB\n\n## Test strategy\nC\n\n## Risks and anything you are unsure about\nD");
    expect(r.structured).toBe(true);
    expect(r.sections).toEqual([{ title: "Root cause", body: "A" }, { title: "Fix", body: "B" }, { title: "Test strategy", body: "C" }, { title: "Risks and anything you are unsure about", body: "D" }]);
  });
  it("keeps an extra section the agent added", () => {
    expect(planSections("## Root cause\nA\n## Fix\nB\n## Files to touch\n- x").sections.map(s => s.title)).toEqual(["Root cause", "Fix", "Files to touch"]);
  });
  it("accepts any heading level", () => {
    expect(planSections("### Root cause\nA\n# Fix\nB").structured).toBe(true);
  });
  it("is unstructured without a root cause and a fix", () => {
    const r = planSections("## Fix\nB");
    expect(r.structured).toBe(false);
  });
  // Review Focus 2.
  it("a plan using bold lines instead of headings is one unstructured section", () => {
    const r = planSections("**Root cause**\nA\n\n**Fix**\nB");
    expect(r.structured).toBe(false);
    expect(r.sections).toEqual([{ title: "", body: "**Root cause**\nA\n\n**Fix**\nB" }]);
  });
  it("ignores # lines inside code fences", () => {
    const r = planSections("## Root cause\n```\n# not a heading\n```\n## Fix\nB");
    expect(r.sections[0].body).toContain("# not a heading");
  });
});

describe("parseHunks", () => {
  const patch = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x",
    "@@ -1,3 +1,3 @@ function f()", " keep", "-old", "+new", " tail",
    "@@ -10,1 +10,2 @@", " ten", "+eleven", "\\ No newline at end of file"].join("\n");
  it("numbers old and new lines across hunks and drops headers and markers", () => {
    expect(parseHunks(patch)).toEqual([
      { kind: "file", text: "x" },
      { kind: "hunk", context: "function f()" },
      { kind: "ctx", oldNo: 1, newNo: 1, text: "keep" },
      { kind: "del", oldNo: 2, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 2, text: "new" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "tail" },
      { kind: "hunk", context: "" },
      { kind: "ctx", oldNo: 10, newNo: 10, text: "ten" },
      { kind: "add", oldNo: null, newNo: 11, text: "eleven" },
    ]);
  });
  it("names a renamed file by its new path and notes binary files", () => {
    const r = parseHunks("diff --git a/old.png b/new.png\nsimilarity index 90%\nrename from old.png\nrename to new.png\nBinary files a/old.png and b/new.png differ");
    expect(r).toEqual([{ kind: "file", text: "old.png → new.png" }, { kind: "note", text: "Binary file — not shown" }]);
  });
});
```

Add to `ui/test/format.test.ts` (create with the imports if the file does not exist):

```ts
import { describe, it, expect } from "vitest";
import { relativeTime } from "../src/format";

describe("relativeTime", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it.each([
    ["2026-10-05T11:59:40Z", "just now"], ["2026-10-05T11:54:00Z", "6 min ago"],
    ["2026-10-05T09:00:00Z", "3 h ago"], ["2026-10-03T12:00:00Z", "2 d ago"],
  ])("%s → %s", (iso, want) => expect(relativeTime(iso, now)).toBe(want));
  it("null is a dash", () => expect(relativeTime(null, now)).toBe("—"));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/bugView.test.ts test/format.test.ts`
Expected: FAIL — `../src/bugView` not found; `relativeTime` not exported.

- [ ] **Step 3: Implement `relativeTime`**

Append to `ui/src/format.ts`:

```ts
/** "6 min ago" — for the screen; the absolute time goes in a title attribute beside it. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
```

- [ ] **Step 4: Implement `bugView.ts`**

`ui/src/bugView.ts`:

```ts
import type { Assumption, BugStage, BugTask, Pending, SessionActivity, SetupReport } from "./types";

// Copies of the server's stage groups (types.ts there exports them as values, but the ui only
// imports server *types*). `bugView.test.ts` pins these equal to the server's.
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr", "review-feedback", "rebase"];
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review", "approved"];
export const SERVER_STAGES: BugStage[] = ["pushing", "creating-pr", "merging"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
const UNREACHABLE = "could not check the pull request:";

const LABELS: Record<BugStage, string> = {
  intake: "Setting up", analyzing: "Analyzing", "plan-review": "Plan review", implementing: "Implementing",
  "diff-review": "Diff review", "opening-pr": "Writing the PR", pushing: "Pushing the branch",
  "creating-pr": "Opening the pull request", monitoring: "Watching the PR", "review-feedback": "Addressing review",
  rebase: "Rebasing", approved: "Ready to merge", merging: "Merging", done: "Done", cancelled: "Cancelled", failed: "Failed",
};
export const stageLabel = (s: BugStage): string => LABELS[s];

export type StepState = "done" | "current" | "waiting" | "failed" | "cancelled" | "todo";
export interface Step { id: string; label: string; state: StepState; badge?: string }
const STEPS: Array<{ id: string; label: string; stages: BugStage[] }> = [
  { id: "intake", label: "Intake", stages: ["intake"] },
  { id: "analyze", label: "Analyze", stages: ["analyzing"] },
  { id: "plan", label: "Plan review", stages: ["plan-review"] },
  { id: "implement", label: "Implement", stages: ["implementing"] },
  { id: "diff", label: "Diff review", stages: ["diff-review"] },
  { id: "pr", label: "Open PR", stages: ["opening-pr", "pushing", "creating-pr"] },
  { id: "monitor", label: "Monitor", stages: ["monitoring", "review-feedback", "rebase"] },
  { id: "merge", label: "Merge", stages: ["approved", "merging", "done"] },
];

/** The stage that says where the task *is*: for a failed/cancelled task, the last real stage. */
function positionStage(task: BugTask): BugStage {
  if (task.stage !== "failed" && task.stage !== "cancelled") return task.stage;
  return [...task.history].reverse().find(h => !TERMINAL_STAGES.includes(h.stage))?.stage ?? "intake";
}

export function pipelineFor(task: BugTask, agentWaiting: boolean): Step[] {
  const pos = positionStage(task);
  const at = Math.max(0, STEPS.findIndex(s => s.stages.includes(pos)));
  return STEPS.map((s, i): Step => {
    let state: StepState;
    if (task.stage === "done") state = "done";
    else if (i < at) state = "done";
    else if (i > at) state = "todo";
    else if (task.stage === "failed") state = "failed";
    else if (task.stage === "cancelled") state = "cancelled";
    else if (GATE_STAGES.includes(task.stage) || agentWaiting) state = "waiting";
    else state = "current";
    return { id: s.id, label: s.label, state, ...(s.id === "monitor" && task.feedbackRounds > 0 ? { badge: `round ${task.feedbackRounds}` } : {}) };
  });
}

export type ListStatus = "running" | "waiting" | "failed" | "done" | "cancelled";
export function listStatus(task: BugTask, agentWaiting: boolean): ListStatus {
  if (task.stage === "failed" || task.stage === "cancelled" || task.stage === "done") return task.stage;
  return GATE_STAGES.includes(task.stage) || agentWaiting ? "waiting" : "running";
}

/** Agent text → one plain line: markdown syntax and newlines out, capped. */
function oneLine(text: string, max = 140): string {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>]+/g, "").replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
}

function gateHeadline(task: BugTask): string {
  const g = task.gate;
  if (!g) return "";
  if (g.kind === "plan") return "Waiting on you: approve the plan";
  if (g.kind === "diff") return g.reason === "rebase" ? "Waiting on you: review the rebased branch"
    : g.reason === "feedback" ? "Waiting on you: review the changes made for the reviewers" : "Waiting on you: review the diff";
  return "Waiting on you: merge the pull request";
}

export interface Now { headline: string; detail?: string; since?: string }
export function nowFor({ task, pending, activity }: { task: BugTask; pending: Pending | null; activity: SessionActivity | null }): Now {
  const since = task.history.at(-1)?.at;
  if (task.stage === "done") return { headline: task.outcome === "closed" || (!task.outcome && task.pr?.state === "CLOSED") ? "Closed without merging" : "Merged" };
  if (task.stage === "cancelled") return { headline: "Cancelled" };
  if (task.stage === "failed") return { headline: `Failed while ${stageLabel(positionStage(task)).toLowerCase()}` };
  if (task.gate) return { headline: gateHeadline(task), since: task.gate.openedAt || since };
  if (pending) return { headline: `${stageLabel(task.stage)} · waiting on you`, detail: pending.kind === "question" ? "The agent has a question" : `The agent wants to run ${pending.toolName}` };
  if (task.stage === "pushing") return { headline: "AgentGrid is pushing the branch", since };
  if (task.stage === "creating-pr") return { headline: "AgentGrid is opening the pull request", since };
  if (task.stage === "merging") return { headline: "AgentGrid is merging", since };
  if (task.stage === "monitoring") return { headline: task.pr ? `Watching PR #${task.pr.number}` : "Watching the PR", ...(task.prCheckedAt ? { since: task.prCheckedAt } : {}) };
  if (task.stage === "intake") return { headline: "Setting up the worktree", since };
  const raw = activity?.pendingTool?.summary || activity?.lastMessage || "";
  return { headline: stageLabel(task.stage), since, ...(raw ? { detail: oneLine(raw) } : {}) };
}

export const newestToken = (task: BugTask): string | null => task.assumptions.at(-1)?.id.split(":")[0] ?? null;
export const isNew = (a: Assumption, task: BugTask): boolean => a.id.split(":")[0] === newestToken(task);

const STAGE_ORDER: BugStage[] = ["analyzing", "implementing", "review-feedback", "rebase"];
export function orderAssumptions(items: Assumption[]): Assumption[] {
  return items.map((a, i) => ({ a, i })).sort((x, y) =>
    (x.a.kind === "question" ? 0 : 1) - (y.a.kind === "question" ? 0 : 1)
    || STAGE_ORDER.indexOf(x.a.stage) - STAGE_ORDER.indexOf(y.a.stage)
    || x.i - y.i).map(x => x.a);
}

export interface Blocker { kind: "gate" | "agent" | "failed" | "pr" | "setup" | "questions"; title: string; detail?: string }
export function blockersFor({ task, pending, setup, setupError }: { task: BugTask; pending: Pending | null; setup: SetupReport | null; setupError: boolean }): Blocker[] {
  if (task.stage === "done" || task.stage === "cancelled") return [];
  if (task.stage === "failed") return [{ kind: "failed", title: `The ${stageLabel(positionStage(task))} stage failed`, ...(task.error ? { detail: task.error } : {}) }];
  const out: Blocker[] = [];
  if (task.gate) out.push({ kind: "gate", title: gateHeadline(task) });
  if (pending) out.push({ kind: "agent", title: pending.kind === "question" ? "The agent has a question for you" : `The agent wants permission to run ${pending.toolName}` });
  if (task.pr && (task.stage === "monitoring" || task.stage === "approved")) {
    if (task.pr.checks === "FAILURE" || task.pr.checks === "ERROR") out.push({ kind: "pr", title: "Checks are failing" });
    if (task.pr.reviewDecision === "CHANGES_REQUESTED") out.push({ kind: "pr", title: "Reviewers asked for changes" });
    if (task.pr.mergeable === "CONFLICTING") out.push({ kind: "pr", title: `The branch conflicts with ${task.baseBranch}` });
  }
  if (task.error?.startsWith(UNREACHABLE)) out.push({ kind: "pr", title: "Could not check the pull request", detail: task.error.slice(UNREACHABLE.length).trim() });
  if (setupError) out.push({ kind: "setup", title: "Could not check setup" });
  else for (const c of setup?.checks ?? []) if (c.blocks && c.state !== "ok") out.push({ kind: "setup", title: c.detail });
  if (task.gate) {
    const n = task.assumptions.filter(a => a.kind === "question" && isNew(a, task)).length;
    if (n) out.push({ kind: "questions", title: `${n} question${n === 1 ? "" : "s"} to answer before approving` });
  }
  return out;
}

export interface PlanSection { title: string; body: string }
export function planSections(md: string): { sections: PlanSection[]; structured: boolean } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sections: PlanSection[] = [];
  let cur: PlanSection = { title: "", body: "" };
  let fence = false;
  const push = () => { cur.body = cur.body.trim(); if (cur.title || cur.body) sections.push(cur); };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { push(); cur = { title: h[1], body: "" }; continue; }
    cur.body += line + "\n";
  }
  push();
  // A bare document title ("# Plan" with nothing under it) is not a section.
  if (sections.length > 1 && !sections[0].body) sections.shift();
  const structured = sections.some(s => /root cause/i.test(s.title)) && sections.some(s => /^fix\b/i.test(s.title));
  return structured ? { sections, structured } : { sections: [{ title: "", body: md.trim() }], structured: false };
}

export type DiffRow =
  | { kind: "file"; text: string }
  | { kind: "hunk"; context: string }
  | { kind: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "note"; text: string };

export function parseHunks(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0, newNo = 0, renameFrom: string | null = null;
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (file) { rows.push({ kind: "file", text: file[2] }); renameFrom = null; continue; }
    const from = /^rename from (.+)$/.exec(line); if (from) { renameFrom = from[1]; continue; }
    const to = /^rename to (.+)$/.exec(line);
    if (to && renameFrom) { const last = [...rows].reverse().find(r => r.kind === "file") as { kind: "file"; text: string } | undefined; if (last) last.text = `${renameFrom} → ${to[1]}`; continue; }
    if (/^Binary files /.test(line)) { rows.push({ kind: "note", text: "Binary file — not shown" }); continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); rows.push({ kind: "hunk", context: h[3].trim() }); continue; }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|old mode|new mode|\\ )/.test(line)) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return rows;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ui && npx vitest run test/bugView.test.ts test/format.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS. If the stage-groups test cannot import the server module's values, change its import to `../../server/src/bugfix/types.ts`; if that still fails under the ui tsconfig, keep the test and add `"../server/src/bugfix/types.ts"` to the ui tsconfig `include`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/bugView.ts ui/src/format.ts ui/test/bugView.test.ts ui/test/format.test.ts
git commit -m "feat(ui): derive a bug's pipeline, now-line, blockers, plan sections and diff rows"
```

---

### Task 5: Plan, diff and gates rendered properly; `BugGates` extracted

**Files:**
- Create: `ui/src/components/PlanView.tsx`, `ui/src/components/DiffView.tsx`, `ui/src/components/BugGates.tsx`
- Modify: `ui/src/components/BugPanel.tsx` (becomes header + `BugGates` + "Open full view")
- Modify: `ui/src/components/SidePanel.tsx:113-114` (outcome via `Markdown`, error via `ErrorCard`)
- Modify: `ui/src/styles.css` (`.plan`, `.diffview`, `.stagechip`)
- Test: `ui/test/PlanView.test.tsx`, `ui/test/DiffView.test.tsx`, `ui/test/BugPanel.test.tsx`, `ui/test/SidePanel.test.tsx`

**Interfaces:**
- Consumes: `Markdown`, `ErrorCard` (Task 3); `planSections`, `parseHunks`, `stageLabel` (Task 4).
- Produces:
  - `PlanView({ markdown, files?, onOpenFile? }: { markdown: string; files?: string[]; onOpenFile?: (path: string) => void })`
  - `DiffView({ patch }: { patch: string })`
  - `BugGates({ task, onChanged, onTranscript? }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void })` — everything `BugPanel` rendered below its header row, unchanged in behaviour.
  - `hunksFor(patch, file)` moves to `DiffView.tsx` and is exported.
  - `BugPanel` keeps its props; its stage chip shows `stageLabel(stage)` and carries `data-stage={stage}`.

- [ ] **Step 1: Write the failing tests**

`ui/test/PlanView.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "../src/components/PlanView";

const PLAN = "# Plan\n\n## Root cause\nThe **token** rotates twice.\n\n## Fix\n- `src/auth/session.ts`: rotate once\n\n## Test strategy\nA unit test.\n\n## Risks and anything you are unsure about\nNone.";

describe("PlanView", () => {
  it("shows each section as its own titled block with no markdown syntax", () => {
    const { container } = render(<PlanView markdown={PLAN} />);
    for (const t of ["Root cause", "Fix", "Test strategy", "Risks and anything you are unsure about"]) expect(screen.getByRole("heading", { name: t })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/##|\*\*|`/);
  });
  it("links a file named in the plan to the diff when that file changed", async () => {
    const onOpenFile = vi.fn();
    render(<PlanView markdown={PLAN} files={["src/auth/session.ts"]} onOpenFile={onOpenFile} />);
    await userEvent.click(screen.getByRole("button", { name: "src/auth/session.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/auth/session.ts");
  });
  it("renders a plan without the usual headings whole, with a quiet note", () => {
    const { container } = render(<PlanView markdown={"**Root cause**\nA"} />);
    expect(screen.getByText(/doesn't follow the usual sections/i)).toBeInTheDocument();
    expect(container.querySelector("strong")!.textContent).toBe("Root cause");
  });
});
```

`ui/test/DiffView.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "../src/components/DiffView";

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn()\n keep\n-old\n+new\n";

describe("DiffView", () => {
  it("renders gutters, tinted rows and a labelled hunk divider, with no patch headers", () => {
    const { container } = render(<DiffView patch={PATCH} />);
    expect(container.querySelector("tr.add td.code")!.textContent).toBe("new");
    expect(container.querySelector("tr.del td.code")!.textContent).toBe("old");
    expect(screen.getByText("fn()")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\+\+\+|---|@@/);
    expect(container.querySelector("tr.add td.ln.new")!.textContent).toBe("2");
  });
});
```

In `ui/test/BugPanel.test.tsx`, replace the first test's stage assertion with:

```tsx
    expect(screen.getByTestId("bug-stage")).toHaveTextContent("Implementing");
    expect(screen.getByTestId("bug-stage")).toHaveAttribute("data-stage", "implementing");
```

and add:

```tsx
  it("renders the plan as sections, not markdown source", async () => {
    bugPlan.mockResolvedValueOnce({ markdown: "## Root cause\nThe **token** rotates.\n\n## Fix\nOnce." });
    const { container } = render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Root cause" })).toBeInTheDocument();
    expect(container.querySelector(".planmd")).toBeNull();
    expect(container.textContent).not.toContain("**");
  });

  it("shows a failed stage as an error card", () => {
    render(<BugPanel task={task("failed", { error: "no commits on the task branch. Check the worktree." })} onChanged={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no commits on the task branch.");
  });

  it("links to the full view", () => {
    render(<BugPanel task={task("implementing")} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: /open full view/i })).toHaveAttribute("href", "#/bugs/bt1");
  });
```

Update the existing diff-gate tests' assertions that read raw patch text (they look for `+added line` etc. inside `<pre className="hunks">`) to read the rendered row text instead (e.g. `expect(screen.getByText("new session line")).toBeInTheDocument()`), keeping what each test proves (isolation, suffix collision, fallback note).

In `ui/test/SidePanel.test.tsx`, add (reuse that file's agent/assignment fixtures):

```tsx
  it("renders a finished assignment's outcome as markdown", () => {
    // render SidePanel with an assignment { state: "done", outcome: "**Fixed** the `bug`." } using this file's helpers
    // then:
    expect(document.querySelector(".side strong")!.textContent).toBe("Fixed");
    expect(document.body.textContent).not.toContain("**");
  });
```

(Fill the render call from the file's existing "done" test, which already builds a done assignment.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/PlanView.test.tsx test/DiffView.test.tsx test/BugPanel.test.tsx test/SidePanel.test.tsx`
Expected: FAIL — new modules missing; BugPanel still raw.

- [ ] **Step 3: Implement `PlanView` and `DiffView`**

`ui/src/components/PlanView.tsx`:

```tsx
import { planSections } from "../bugView";
import { Markdown } from "./Markdown";

/** The analyze stage's plan as the four blocks it is asked to have, rather than one document. */
export function PlanView({ markdown, files, onOpenFile }: { markdown: string; files?: string[]; onOpenFile?: (path: string) => void }) {
  const { sections, structured } = planSections(markdown);
  const fileLinks = files && onOpenFile ? { files, onOpen: onOpenFile } : undefined;
  return (
    <div className="plan">
      {!structured && <p className="hint">This plan doesn't follow the usual sections.</p>}
      {sections.map((s, i) => (
        <section key={i} className="plansec">
          {s.title && <h5>{s.title}</h5>}
          <Markdown text={s.body} fileLinks={fileLinks} />
        </section>
      ))}
    </div>
  );
}
```

`ui/src/components/DiffView.tsx`:

```tsx
import { parseHunks } from "../bugView";

/**
 * Per-file slice of a unified diff, so each file can be expanded on its own. (Moved here from
 * BugPanel unchanged.) When the split can't isolate this file (a rename, or a header format that
 * doesn't literally name every path in `files[]`), fall back to the whole patch — flagged as
 * unisolated so the card never presents unrelated content as this file's diff.
 */
export function hunksFor(patch: string, file: string): { text: string; isolated: boolean } {
  const parts = patch.split(/^diff --git /m).slice(1);
  const hit = parts.find(p => p.split("\n")[0].trimEnd() === `a/${file} b/${file}`);
  return hit ? { text: `diff --git ${hit}`.trimEnd(), isolated: true } : { text: patch, isolated: false };
}

/** A patch as a diff: gutters, tinted rows, hunk dividers. No syntax highlighting (spec §10). */
export function DiffView({ patch }: { patch: string }) {
  const rows = parseHunks(patch);
  const multiFile = rows.filter(r => r.kind === "file").length > 1;
  return (
    <table className="diffview"><tbody>
      {rows.map((r, i) => {
        if (r.kind === "file") return multiFile ? <tr key={i} className="file"><td colSpan={3}>{r.text}</td></tr> : null;
        if (r.kind === "hunk") return <tr key={i} className="hunk"><td colSpan={3}>{r.context || " "}</td></tr>;
        if (r.kind === "note") return <tr key={i} className="note"><td colSpan={3}>{r.text}</td></tr>;
        return (
          <tr key={i} className={r.kind}>
            <td className="ln old">{r.oldNo ?? ""}</td>
            <td className="ln new">{r.newNo ?? ""}</td>
            <td className="code">{r.text}</td>
          </tr>
        );
      })}
    </tbody></table>
  );
}
```

- [ ] **Step 4: Extract `BugGates` and slim `BugPanel`**

Create `ui/src/components/BugGates.tsx` by **moving** from `BugPanel.tsx`: `describeError`, `Lines` (delete it if no longer used after the changes below), the three `*_LABEL` maps, `PrChips`, every `useState`/`useEffect`/`act`/`planReady`/`diffReady` inside `BugPanel`, and the JSX from `{err && <div className="err">{err}</div>}` to the end. Export it as:

```tsx
export function BugGates({ task, onChanged, onTranscript }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void }) {
  // …moved state, effects and act…
  return (
    <div className="buggates">
      {/* …moved JSX… */}
    </div>
  );
}
```

Inside the moved JSX make exactly these replacements:

1. Plan gate: `<pre className="planmd">{plan ?? "Loading…"}</pre>` →
   ```tsx
   plan === null ? <div className="skeleton" aria-label="Loading the plan"><div /><div /><div /></div> : <PlanView markdown={plan} />
   ```
2. Diff gate: `<pre className="hunks">{h.text}</pre>` → `<DiffView patch={h.text} />`, and import `hunksFor` from `./DiffView` (delete the local copy).
3. Failed gate: `<pre className="outcome err">{task.error}</pre>` → `<ErrorCard text={task.error ?? "The stage failed."} />`.
4. Done gate, merged-with-leftovers: the `<p className="hint">Merged, but cleanup left something behind:</p><Lines …/>` pair → `<ErrorCard title="Merged, but cleanup left something behind" text={task.error} />`.
5. Server-stage hint: `"Pushing…" / "Creating PR…" / "Merging…"` → `stageLabel(task.stage) + "…"`.

`ui/src/components/BugPanel.tsx` becomes:

```tsx
import { stageLabel } from "../bugView";
import type { BugTask } from "../types";
import { BugGates } from "./BugGates";

/** The compact view in the side panel: the ticket, where it is, and the gate actions. The whole
 *  workflow lives on the bug screen (`#/bugs/<id>`). */
export function BugPanel({ task, onChanged, onTranscript }: { task: BugTask; onChanged: (t: BugTask) => void; onTranscript?: (agentId: string) => void }) {
  return (
    <div className="bugpanel" data-testid="bug-panel">
      <div className="bughead">
        <a className="bugkey" href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a>
        <span className="bugtitle">{task.issue.title}</span>
      </div>
      <div className="row dim">
        <span data-testid="bug-stage" data-stage={task.stage} className={`chip ${task.stage}`}>{stageLabel(task.stage)}</span>
        <span>{task.issue.priority}</span>
        <code>{task.branch}</code>
        {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">PR #{task.pr.number}</a>}
        <span style={{ marginLeft: "auto" }}>${task.costUsd.toFixed(2)}</span>
      </div>
      <a className="fullview" href={`#/bugs/${task.id}`}>Open full view →</a>
      <BugGates task={task} onChanged={onChanged} onTranscript={onTranscript} />
    </div>
  );
}
```

Keep the `mergeMethod` reset-on-`task.id` effect and the `taskRef` logic inside `BugGates` exactly as they were — their comments explain why.

- [ ] **Step 5: Side panel outcome and error**

In `ui/src/components/SidePanel.tsx`, replace lines 113–114:

```tsx
        {a.state === "done" && <><h4>Outcome</h4><div className="outcome"><Markdown text={a.outcome ?? ""} /></div></>}
        {a.state === "failed" && <><h4>Failed</h4><ErrorCard text={a.error ?? "The run failed."} /></>}
```

with imports for `Markdown` and `ErrorCard`.

- [ ] **Step 6: Styles**

Append to `ui/src/styles.css`:

```css
.plan { display:flex; flex-direction:column; gap:10px; }
.plansec h5 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--dim); }
.plansec { background:#0f1115; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
.diffview { width:100%; border-collapse:collapse; font:11.5px/1.5 ui-monospace, monospace; background:#0f1115; border-radius:6px; overflow:hidden; }
.diffview td { padding:0 6px; vertical-align:top; } .diffview td.code { white-space:pre-wrap; word-break:break-all; width:100%; }
.diffview td.ln { color:var(--dim2); text-align:right; user-select:none; min-width:3ch; border-right:1px solid var(--line); }
.diffview tr.add { background:#0f2a18; } .diffview tr.add td.code { color:#bbf7d0; }
.diffview tr.del { background:#2a1012; } .diffview tr.del td.code { color:#fecaca; }
.diffview tr.hunk td, .diffview tr.file td, .diffview tr.note td { color:var(--dim); background:#151a24; padding:3px 8px; font-style:italic; }
.skeleton { display:flex; flex-direction:column; gap:6px; } .skeleton div { height:10px; border-radius:4px; background:#1b1f27; animation:blink 1.4s infinite; } .skeleton div:nth-child(2) { width:80%; } .skeleton div:nth-child(3) { width:60%; }
.fullview { display:inline-block; margin-top:8px; color:#93b4ff; font-size:12px; }
```

- [ ] **Step 7: Run the ui suite and typecheck**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/
git commit -m "feat(ui): plans as sections, diffs as diffs, failures as cards; gate cards shared as BugGates"
```

---

### Task 6: The bug screen

**Files:**
- Create: `ui/src/components/BugScreen.tsx`, `ui/src/hooks/useHashRoute.ts`
- Modify: `ui/src/App.tsx` (route, render screen, launcher → screen, Esc), `ui/src/components/TopBar.tsx` (Bugs/Grid button), `ui/src/styles.css` (`.bugscreen` …)
- Test: `ui/test/BugScreen.test.tsx`, `ui/test/useHashRoute.test.ts`, `ui/test/App.test.tsx`

**Interfaces:**
- Consumes: `pipelineFor`, `listStatus`, `nowFor`, `blockersFor`, `orderAssumptions`, `isNew`, `stageLabel` (Task 4); `BugGates`, `PlanView`, `DiffView`, `Markdown`, `ErrorCard` (Tasks 3, 5); `assignmentFor`, `activityFor` from `state/reducer`; `relativeTime`, `usd` from `format`; `api.getSetup`, `api.bugPlan`, `api.bugDiff`.
- Produces:
  - `useHashRoute(): { view: "grid" | "bugs"; bugId: string | null; go: (r: { view: "grid" } | { view: "bugs"; bugId?: string | null }) => void }`
  - `parseHash(hash: string): { view: "grid" | "bugs"; bugId: string | null }` (exported for tests)
  - `BugScreen({ state, selectedId, onSelect, onBugChanged, onTranscript, onOpenSettings, onFixBug }: { state: UiState; selectedId: string | null; onSelect: (id: string) => void; onBugChanged: (t: BugTask) => void; onTranscript: (agentId: string) => void; onOpenSettings: () => void; onFixBug: () => void })`
  - `TopBar` gains `onToggleBugs: () => void; bugsActive: boolean`.

- [ ] **Step 1: Write the failing tests**

`ui/test/useHashRoute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseHash } from "../src/hooks/useHashRoute";

describe("parseHash", () => {
  it.each([
    ["", { view: "grid", bugId: null }], ["#/", { view: "grid", bugId: null }],
    ["#/bugs", { view: "bugs", bugId: null }], ["#/bugs/bt3", { view: "bugs", bugId: "bt3" }],
    ["#/bugs/../x", { view: "bugs", bugId: null }], ["#/nonsense", { view: "grid", bugId: null }],
  ])("%s", (h, want) => expect(parseHash(h)).toEqual(want));
});
```

`ui/test/BugScreen.test.tsx` — mock `../src/api` the same way `BugPanel.test.tsx` does (copy its `vi.hoisted` ApiError and `vi.mock` block, adding `getSetup: vi.fn(async () => ({ ready: true, wired: true, addCommand: "", discovery: { servers: [], problems: [] }, checks: [] }))`), and reuse its `task()` helper shape with `assumptions`/`assumptionsProblem` added. Then:

```tsx
import { initial } from "../src/state/reducer";

const stateWith = (tasks: BugTask[]) => ({ ...initial, bugTasks: Object.fromEntries(tasks.map(t => [t.id, t])) });
const renderScreen = (tasks: BugTask[], selectedId: string | null = tasks[0]?.id ?? null, extra = {}) => {
  const onSelect = vi.fn();
  render(<BugScreen state={stateWith(tasks) as never} selectedId={selectedId} onSelect={onSelect} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} {...extra} />);
  return { onSelect };
};

describe("BugScreen", () => {
  it("lists every bug with a status word, active ones first", () => {
    renderScreen([task("done", { id: "bt1", issue: { ...ISSUE, key: "PAY-1" } }), task("plan-review", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt2");
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("PAY-2"); expect(rows[0]).toHaveTextContent(/waiting on you/i);
    expect(rows[1]).toHaveTextContent("PAY-1"); expect(rows[1]).toHaveTextContent(/done/i);
  });

  it("shows the pipeline with the current step marked in words", () => {
    renderScreen([task("implementing")]);
    const strip = screen.getByRole("list", { name: /pipeline/i });
    expect(within(strip).getByText("Implement").closest("li")).toHaveAttribute("data-state", "current");
    expect(within(strip).getAllByText(/^done$/i).length).toBeGreaterThan(0);
  });

  it("says nothing is blocking when nothing is", () => {
    renderScreen([task("implementing")]);
    expect(screen.getByText("Nothing is blocking this bug.")).toBeInTheDocument();
  });

  it("puts an open gate first in Blocking", () => {
    renderScreen([task("plan-review")]);
    expect(screen.getByRole("region", { name: /blocking/i })).toHaveTextContent("Waiting on you: approve the plan");
  });

  it("lists assumptions questions-first, tagged by stage, new ones marked, with the problem line", () => {
    renderScreen([task("plan-review", { assumptionsProblem: "The analyzing stage's assumptions file is not valid JSON.", assumptions: [
      { id: "a:0", stage: "analyzing", round: 0, kind: "assumption", text: "Rounding is **only** at checkout", at: "t" },
      { id: "a:1", stage: "analyzing", round: 0, kind: "question", text: "Up or down?", at: "t" },
    ] })]);
    const region = screen.getByRole("region", { name: /assumptions/i });
    const items = within(region).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Up or down?");
    expect(items[1]).toHaveTextContent(/Analyzing/);
    expect(items[0]).toHaveTextContent(/new/i);
    expect(region.querySelector("strong")!.textContent).toBe("only");
    expect(region).toHaveTextContent(/not valid JSON/);
  });

  it("renders the ticket description as markdown", async () => {
    const { container } = render(<BugScreen state={stateWith([task("implementing", { issue: { ...ISSUE, description: "Steps:\n1. **Open** it" } })]) as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    await userEvent.click(screen.getByText("Ticket"));
    expect(container.querySelector(".section-collapse strong")!.textContent).toBe("Open");
  });

  it("has an empty state for assumptions", () => {
    renderScreen([task("analyzing")]);
    expect(screen.getByText("The agent has not reported any assumptions yet.")).toBeInTheDocument();
  });

  it("shows the timeline newest first with readable stage names", () => {
    renderScreen([task("plan-review", { history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage: "analyzing", at: "2026-10-05T10:01:00Z", note: "" }, { stage: "plan-review", at: "2026-10-05T10:05:00Z", note: "Plan written" }] })]);
    const items = within(screen.getByRole("region", { name: /timeline/i })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Plan review"); expect(items[0]).toHaveTextContent("Plan written");
    expect(items[2]).toHaveTextContent("Setting up");
    expect(screen.queryByText("plan-review")).toBeNull();
  });

  it("approves from the screen through the same API the side panel uses", async () => {
    renderScreen([task("plan-review")]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve & implement" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
  });

  it("moves through the list with the arrow keys", async () => {
    const { onSelect } = renderScreen([task("implementing", { id: "bt1" }), task("analyzing", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt1");
    screen.getAllByRole("option")[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenCalledWith("bt2");
  });

  // Review Focus 4.
  it("falls back to the first bug when the selected one no longer exists", () => {
    const { onSelect } = renderScreen([task("implementing", { id: "bt1" })], "bt9");
    expect(onSelect).toHaveBeenCalledWith("bt1");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("PAY-42");
  });

  it("has an empty state with a way to start", () => {
    const onFixBug = vi.fn();
    render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={onFixBug} />);
    expect(screen.getByText(/no bug fixes yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🐞 Fix a bug" })).toBeInTheDocument();
  });

  it("says when setup could not be checked", async () => {
    getSetup.mockRejectedValueOnce(new Error("down"));
    renderScreen([task("implementing")]);
    expect(await screen.findByText("Could not check setup")).toBeInTheDocument();
  });
});
```

(`ISSUE` is the `issue` object from the `task()` helper; `getSetup` and `approveBug` are the mocked fns; import `within` from Testing Library.)

In `ui/test/App.test.tsx`, add (following that file's existing render/mocking pattern):

```tsx
  it("the Bugs button switches to the bug screen and back, and the hash follows", async () => {
    // render <App /> as the file's other tests do
    await userEvent.click(screen.getByRole("button", { name: "Bugs" }));
    expect(window.location.hash).toBe("#/bugs");
    expect(screen.getByTestId("bug-screen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(window.location.hash).toBe("");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run test/useHashRoute.test.ts test/BugScreen.test.tsx test/App.test.tsx`
Expected: FAIL — modules missing, no Bugs button.

- [ ] **Step 3: Implement `useHashRoute`**

`ui/src/hooks/useHashRoute.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

export type Route = { view: "grid" | "bugs"; bugId: string | null };

/** `#/bugs/<id>` → the bug screen on that bug. Only our own id shape is accepted as an id. */
export function parseHash(hash: string): Route {
  const m = /^#\/bugs(?:\/([^/]*))?$/.exec(hash);
  if (!m) return { view: "grid", bugId: null };
  return { view: "bugs", bugId: m[1] && /^bt\d+$/.test(m[1]) ? m[1] : null };
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: { view: "grid" } | { view: "bugs"; bugId?: string | null }) => {
    const hash = r.view === "grid" ? "" : r.bugId ? `#/bugs/${r.bugId}` : "#/bugs";
    if (hash === "") history.pushState(null, "", window.location.pathname + window.location.search);
    else window.location.hash = hash;
    setRoute(parseHash(hash));
  }, []);
  return { ...route, go };
}
```

- [ ] **Step 4: Implement `BugScreen`**

`ui/src/components/BugScreen.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { blockersFor, isNew, listStatus, nowFor, orderAssumptions, pipelineFor, stageLabel, type Blocker, type ListStatus, type StepState } from "../bugView";
import { relativeTime, usd } from "../format";
import { activityFor, assignmentFor, type UiState } from "../state/reducer";
import type { BugTask, SetupReport } from "../types";
import { BugGates } from "./BugGates";
import { DiffView, hunksFor } from "./DiffView";
import { ErrorCard } from "./ErrorCard";
import { Markdown } from "./Markdown";
import { PlanView } from "./PlanView";

const STATUS: Record<ListStatus, { icon: string; word: string }> = {
  running: { icon: "●", word: "Running" }, waiting: { icon: "⚠", word: "Waiting on you" },
  failed: { icon: "✗", word: "Failed" }, done: { icon: "✓", word: "Done" }, cancelled: { icon: "–", word: "Cancelled" },
};
const STEP: Record<StepState, { icon: string; word: string }> = {
  done: { icon: "✓", word: "done" }, current: { icon: "●", word: "in progress" }, waiting: { icon: "⚠", word: "waiting on you" },
  failed: { icon: "✗", word: "failed" }, cancelled: { icon: "–", word: "cancelled" }, todo: { icon: "○", word: "not reached" },
};
const ACTIVE_FIRST: ListStatus[] = ["waiting", "running", "failed", "done", "cancelled"];

/** Re-render every 30s so relative times and elapsed stay honest. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return now;
}

function When({ iso, now }: { iso?: string | null; now: number }) {
  if (!iso) return null;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{relativeTime(iso, now)}</time>;
}

export function BugScreen({ state, selectedId, onSelect, onBugChanged, onTranscript, onOpenSettings, onFixBug }: {
  state: UiState; selectedId: string | null; onSelect: (id: string) => void; onBugChanged: (t: BugTask) => void;
  onTranscript: (agentId: string) => void; onOpenSettings: () => void; onFixBug: () => void;
}) {
  const now = useNow();
  const agentWaiting = (t: BugTask) => {
    const ag = state.agents.find(a => a.id === t.agentId);
    return !!ag && !!assignmentFor(state, ag)?.pending;
  };
  const tasks = useMemo(() => Object.values(state.bugTasks)
    .map(t => ({ t, status: listStatus(t, agentWaiting(t)) }))
    .sort((a, b) => ACTIVE_FIRST.indexOf(a.status) - ACTIVE_FIRST.indexOf(b.status) || b.t.updatedAt.localeCompare(a.t.updatedAt)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [state.bugTasks, state.assignments, state.agents]);

  const task = tasks.find(x => x.t.id === selectedId)?.t ?? null;
  // Review Focus 4: a stale or missing selection falls back to the first bug, and the URL follows.
  useEffect(() => { if (!task && tasks.length) onSelect(tasks[0].t.id); }, [task, tasks, onSelect]);
  const shown = task ?? tasks[0]?.t ?? null;

  if (!tasks.length) {
    return (
      <div className="bugscreen empty-screen" data-testid="bug-screen">
        <p>No bug fixes yet. Start one and it will appear here, step by step.</p>
        <button className="btn p" onClick={onFixBug}>🐞 Fix a bug</button>
      </div>
    );
  }

  const move = (delta: number) => {
    const i = tasks.findIndex(x => x.t.id === shown?.id);
    const next = tasks[Math.min(tasks.length - 1, Math.max(0, i + delta))];
    if (next) onSelect(next.t.id);
  };

  return (
    <div className="bugscreen" data-testid="bug-screen">
      <ul className="buglist" role="listbox" aria-label="Bug fixes" onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      }}>
        {tasks.map(({ t, status }) => (
          <li key={t.id} role="option" aria-selected={t.id === shown?.id} tabIndex={t.id === shown?.id ? 0 : -1}
            className={`bugrow ${status}`} onClick={() => onSelect(t.id)} onKeyDown={e => { if (e.key === "Enter") onSelect(t.id); }}>
            <span className="bugrow-key">{t.issue.key}</span>
            <span className="bugrow-title">{t.issue.title}</span>
            <span className={`status ${status}`}>{STATUS[status].icon} {STATUS[status].word}</span>
          </li>
        ))}
      </ul>
      {shown && <BugDetail key={shown.id} task={shown} state={state} now={now} onBugChanged={onBugChanged} onTranscript={onTranscript} onOpenSettings={onOpenSettings} />}
    </div>
  );
}

function BugDetail({ task, state, now, onBugChanged, onTranscript, onOpenSettings }: {
  task: BugTask; state: UiState; now: number; onBugChanged: (t: BugTask) => void; onTranscript: (agentId: string) => void; onOpenSettings: () => void;
}) {
  const agent = state.agents.find(a => a.id === task.agentId) ?? null;
  const asg = agent ? assignmentFor(state, agent) : null;
  const activity = agent ? activityFor(state, agent) : null;
  const pending = asg?.pending ?? null;

  const [setup, setSetup] = useState<SetupReport | null>(null);
  const [setupError, setSetupError] = useState(false);
  useEffect(() => {
    let live = true;
    api.getSetup().then(r => { if (live) { setSetup(r); setSetupError(false); } }).catch(() => { if (live) setSetupError(true); });
    return () => { live = false; };
  }, [task.stage]);

  // The plan and the diff, shown outside their own gates once they exist.
  const [plan, setPlan] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ patch: string; files: Array<{ path: string; additions: number; deletions: number }> } | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const hasPlan = task.stage !== "intake" && task.stage !== "analyzing";
  const hasDiff = !!task.approvedHead && task.stage !== "done" && task.stage !== "cancelled";
  useEffect(() => { let live = true; if (hasPlan) api.bugPlan(task.id).then(r => { if (live) setPlan(r.markdown || null); }).catch(() => {}); return () => { live = false; }; }, [task.id, hasPlan]);
  useEffect(() => {
    let live = true;
    if (hasDiff) api.bugDiff(task.id).then(r => { if (live) { setDiff(r); setDiffErr(null); } }).catch(e => { if (live) setDiffErr((e as Error).message); });
    return () => { live = false; };
  }, [task.id, hasDiff, task.approvedHead]);

  const steps = pipelineFor(task, !!pending);
  const nowLine = nowFor({ task, pending, activity });
  const blockers = blockersFor({ task, pending, setup, setupError });
  const items = orderAssumptions(task.assumptions);
  const openInDiff = (p: string) => { setOpenFile(p); document.getElementById("bug-changes")?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <div className="bugdetail">
      <header className="bugdetail-head">
        <h2><a href={task.issue.url} target="_blank" rel="noreferrer">{task.issue.key}</a> <span>{task.issue.title}</span></h2>
        <div className="row dim">
          {task.pr && <a href={task.pr.url} target="_blank" rel="noreferrer">Pull request #{task.pr.number}</a>}
          <code title="Worktree">{task.worktree}</code>
          <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(task.worktree)}>Copy path</button>
          <span>{usd(task.costUsd)}</span>
          {task.feedbackRounds > 0 && <span>Review round {task.feedbackRounds}</span>}
          {agent && <button className="btn sm" onClick={() => onTranscript(agent.id)}>Transcript</button>}
        </div>
      </header>

      <ol className="pipeline" aria-label="Pipeline">
        {steps.map(s => (
          <li key={s.id} data-state={s.state} className={`step ${s.state}`}>
            <span className="step-icon" aria-hidden>{STEP[s.state].icon}</span>
            <span className="step-label">{s.label}</span>
            <span className="step-word">{STEP[s.state].word}</span>
            {s.badge && <span className="chip">{s.badge}</span>}
          </li>
        ))}
      </ol>

      <section className={`blocking ${blockers.length ? "has" : "none"}`} aria-label="Blocking">
        <h3>Blocking</h3>
        {blockers.length === 0 ? <p className="dim">Nothing is blocking this bug.</p> : (
          <ul>{blockers.map((b, i) => <BlockerRow key={i} b={b} onOpenSettings={onOpenSettings} />)}</ul>
        )}
      </section>

      <section className="now" aria-label="Now">
        <h3>Now</h3>
        <div className="now-line"><b>{nowLine.headline}</b>{nowLine.since && <> · <When iso={nowLine.since} now={now} /></>}</div>
        {nowLine.detail && <div className="now-detail">{nowLine.detail}</div>}
      </section>

      <section className="gates" aria-label="Actions">
        <BugGates task={task} onChanged={onBugChanged} onTranscript={onTranscript} />
      </section>

      <section className="assumptions" aria-label="Assumptions and questions">
        <h3>Assumptions & questions {items.length > 0 && <span className="dim">({items.length})</span>}</h3>
        {task.assumptionsProblem && <div className="warnline">⚠ {task.assumptionsProblem}</div>}
        {items.length === 0 ? <p className="dim">The agent has not reported any assumptions yet.</p> : (
          <ul>{items.map(a => (
            <li key={a.id} className={`assumption ${a.kind}`}>
              <span className="akind">{a.kind === "question" ? "? Question" : "• Assumed"}</span>
              <Markdown inline text={a.text} />
              <span className="atag">{stageLabel(a.stage)}{a.round > 0 ? ` · round ${a.round}` : ""}</span>
              {isNew(a, task) && <span className="chip new">new</span>}
            </li>
          ))}</ul>
        )}
      </section>

      {task.issue.description.trim() && (
        <details className="section-collapse"><summary>Ticket</summary>
          <Markdown text={task.issue.description} />
          {task.issue.acceptanceCriteria.length > 0 && <><h4>Acceptance criteria</h4><ul>{task.issue.acceptanceCriteria.map((c, i) => <li key={i}><Markdown inline text={c} /></li>)}</ul></>}
        </details>
      )}

      {plan && task.gate?.kind !== "plan" && (
        <details className="section-collapse"><summary>Plan</summary>
          <PlanView markdown={plan} files={diff?.files.map(f => f.path)} onOpenFile={openInDiff} />
        </details>
      )}

      {hasDiff && task.gate?.kind !== "diff" && (
        <section id="bug-changes" aria-label="Changes">
          <h3>Changes</h3>
          {diffErr ? <ErrorCard text={`Could not load the changes. ${diffErr}`} />
            : !diff ? <div className="skeleton" aria-label="Loading the changes"><div /><div /></div>
            : <ul className="difffiles">{diff.files.map(f => (
                <li key={f.path}>
                  <button className="folder" aria-expanded={openFile === f.path} onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
                    <code>{f.path}</code> <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                  </button>
                  {openFile === f.path && (() => { const h = hunksFor(diff.patch, f.path); return <>
                    {!h.isolated && <p className="hint">Could not isolate this file's changes — showing the full diff instead.</p>}
                    <DiffView patch={h.text} />
                  </>; })()}
                </li>
              ))}</ul>}
        </section>
      )}

      <section className="timeline" aria-label="Timeline">
        <h3>Timeline</h3>
        <ol>{[...task.history].reverse().map((h, i) => (
          <li key={i}><When iso={h.at} now={now} /> <b>{stageLabel(h.stage)}</b>{h.note && <> — <Markdown inline text={h.note} /></>}</li>
        ))}</ol>
      </section>
    </div>
  );
}

function BlockerRow({ b, onOpenSettings }: { b: Blocker; onOpenSettings: () => void }) {
  if (b.kind === "failed") return <li><ErrorCard title={b.title} text={b.detail ?? "No error was recorded."} /></li>;
  return (
    <li className={`blocker ${b.kind}`}>
      <span>{b.title}</span>
      {b.detail && <span className="dim"> — {b.detail}</span>}
      {b.kind === "setup" && <button className="btn sm" onClick={onOpenSettings}>Open Settings</button>}
      {b.kind === "gate" && <button className="btn sm" onClick={() => document.querySelector(".bugdetail .gates")?.scrollIntoView({ behavior: "smooth" })}>Go to it</button>}
      {b.kind === "agent" && <span className="hint"> Answer it in the agent's side panel on the grid.</span>}
    </li>
  );
}
```

If `UiState` is not exported from `state/reducer.ts`, export it (`export type UiState = …`) — it is the type `reducer`/`initial` already use.

- [ ] **Step 5: Wire it into the app**

`TopBar.tsx`: add props `onToggleBugs: () => void; bugsActive: boolean` and, before the "🐞 Fix a bug" button:

```tsx
      <button className={`btn ${bugsActive ? "on" : ""}`} onClick={onToggleBugs}>{bugsActive ? "Grid" : "Bugs"}</button>
```

`App.tsx`:
- `import { useHashRoute } from "./hooks/useHashRoute"; import { BugScreen } from "./components/BugScreen";`
- `const route = useHashRoute();`
- TopBar: `bugsActive={route.view === "bugs"} onToggleBugs={() => route.go(route.view === "bugs" ? { view: "grid" } : { view: "bugs" })}`
- Wrap the existing `<div className="split">…</div>` as `{route.view === "bugs" ? <BugScreen state={s} selectedId={route.bugId} onSelect={id => route.go({ view: "bugs", bugId: id })} onBugChanged={t => dispatch({ type: "change", event: { type: "bugtask", task: t } })} onTranscript={id => setTranscriptFor(id)} onOpenSettings={() => setSettingsOpen(true)} onFixBug={() => setBugOpen(true)} /> : <div className="split">…</div>}`
- `BugLauncher` `onCreated`: `t => { setBugOpen(false); dispatch({ type: "select", id: t.agentId }); route.go({ view: "bugs", bugId: t.id }); }`
- In `useKeyboard`'s `escape`, before the final `dispatch({ type: "select", id: null })`: `if (route.view === "bugs") { route.go({ view: "grid" }); return; }` and add `route` to that `useMemo`'s deps.
- Footer key hint: when `route.view === "bugs"` render `keys: ↑↓ move · enter open · esc grid` instead.

Update the existing `App.test.tsx` test(s) that assert launching a bug selects the agent so they also accept the hash change (assert `window.location.hash === "#/bugs/<id>"`), and reset `window.location.hash = ""` in that file's `beforeEach`.

- [ ] **Step 6: Styles**

Append to `ui/src/styles.css`:

```css
.bugscreen { display:grid; grid-template-columns: 280px 1fr; gap:12px; padding:12px 16px; flex:1; min-height:0; }
.bugscreen.empty-screen { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:var(--dim); }
.buglist { list-style:none; margin:0; padding:6px; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:auto; }
.bugrow { display:grid; grid-template-columns:auto 1fr; gap:2px 8px; padding:8px 10px; border-radius:8px; cursor:pointer; }
.bugrow:hover { background:#1b1f27; } .bugrow[aria-selected="true"] { background:#1e2a44; outline:1px solid #2b4a8a; }
.bugrow:focus-visible, .bugdetail button:focus-visible, .bugdetail a:focus-visible { outline:2px solid #6b8cff; outline-offset:2px; }
.bugrow-key { font-weight:600; } .bugrow-title { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bugrow .status { grid-column:1/-1; font-size:11px; }
.status.running { color:#93b4ff; } .status.waiting { color:#ffd166; } .status.failed { color:#fca5a5; } .status.done { color:#86efac; } .status.cancelled { color:var(--dim2); }
.bugdetail { overflow:auto; display:flex; flex-direction:column; gap:14px; padding-right:4px; }
.bugdetail h2 { margin:0; font-size:16px; } .bugdetail h2 a { color:#93b4ff; text-decoration:none; } .bugdetail h2 span { font-weight:500; }
.bugdetail h3 { margin:0 0 6px; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.5px; }
.bugdetail section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.pipeline { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
.step { display:flex; align-items:center; gap:6px; padding:6px 10px; border-radius:99px; border:1px solid var(--line); background:var(--panel); font-size:12px; }
.step-word { font-size:10.5px; color:var(--dim2); }
.step.done { border-color:#22c55e55; } .step.done .step-icon { color:var(--green); }
.step.current { border-color:var(--blue); background:#14213d; } .step.current .step-icon { color:var(--blue); animation:blink 1.2s infinite; }
.step.waiting { border-color:var(--amber); background:#3a2a05; } .step.waiting .step-icon { color:var(--amber); }
.step.failed { border-color:var(--red); background:#2a1012; } .step.failed .step-icon { color:var(--red); }
.step.todo { opacity:.6; }
.blocking.has { border-color:var(--amber); box-shadow:0 0 0 1px #f59e0b33; }
.blocking ul, .assumptions ul, .timeline ol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.blocker { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.now-line { font-size:13px; } .now-detail { color:#c3c9d5; margin-top:4px; }
.assumption { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; padding:6px 8px; border-radius:6px; background:#0f1115; }
.assumption.question { border-left:3px solid var(--amber); } .assumption.assumption { border-left:3px solid var(--grey); }
.akind { font-size:11px; color:var(--dim); white-space:nowrap; } .atag { margin-left:auto; font-size:11px; color:var(--dim2); }
.chip.new { background:#14213d; border:1px solid var(--blue); color:#93b4ff; font-size:10px; }
.warnline { color:#ffd166; margin-bottom:6px; }
.section-collapse { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; } .section-collapse summary { cursor:pointer; color:var(--dim); text-transform:uppercase; font-size:11px; letter-spacing:.5px; }
.timeline time { color:var(--dim2); font-size:11px; min-width:70px; display:inline-block; }
@media (max-width: 900px) { .bugscreen { grid-template-columns:1fr; } .buglist { max-height:180px; } }
```

- [ ] **Step 7: Run the ui suite and typecheck**

Run: `cd ui && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/
git commit -m "feat(ui): a bug screen — pipeline, now, blocking, assumptions, actions and timeline on one page"
```

---

### Task 7: End to end, version, docs

**Files:**
- Modify: `ui/e2e/bugfix.spec.ts`
- Modify: `desktop/package.json` (`"version": "0.6.0"`)
- Modify: `README.md` (bug-fix section)

**Interfaces:**
- Consumes: everything above; fake agent writes one assumption and one question in analyze (Task 2).

- [ ] **Step 1: Update the e2e flow**

In `ui/e2e/bugfix.spec.ts`, replace every `expect(page.getByTestId("bug-stage")).toContainText("<stage>", …)` with `expect(page.getByTestId("bug-stage")).toHaveAttribute("data-stage", "<stage>", …)` (same stage ids, same timeouts). Then, right after the plan-review wait and **instead of** approving from the side panel, add:

```ts
  // The whole workflow on one screen: open it from the side panel.
  await panel.getByRole("link", { name: /open full view/i }).click();
  const screen = page.getByTestId("bug-screen");
  await expect(screen).toBeVisible();
  await expect(page).toHaveURL(/#\/bugs\/bt\d+$/);
  await expect(screen.getByRole("list", { name: "Pipeline" }).locator('[data-state="waiting"]')).toContainText("Plan review");
  // The fake agent's assumptions arrived, questions first, and are part of what's blocking.
  const assumptions = screen.getByRole("region", { name: /assumptions/i });
  await expect(assumptions.getByRole("listitem").first()).toContainText("Should the fix also add a regression test?");
  await expect(assumptions).toContainText("confined to fake-fix.txt");
  await expect(screen.getByRole("region", { name: /blocking/i })).toContainText("1 question to answer before approving");
  // No markdown source on the plan.
  await expect(screen.getByRole("heading", { name: "Root cause" })).toBeVisible();
  await expect(screen.locator(".plan")).not.toContainText("##");
  await screen.getByRole("button", { name: "Approve & implement" }).click();
  await expect(screen.getByRole("list", { name: "Pipeline" }).locator('[data-state="waiting"]')).toContainText("Diff review", { timeout: 30_000 });

  // Back to the grid for the rest of the flow. Launching selected the bug's agent, and that
  // selection survives the round trip, so its side panel is open again.
  await page.getByRole("button", { name: "Grid" }).click();
  await expect(panel).toBeVisible();
```

and delete the old `await panel.getByText("Root cause")…` / `await panel.getByRole("button", { name: /Approve/ }).click();` pair for the plan gate. (If no `agent-tile` test id exists, select the agent the way `smoke.spec.ts` does.)

- [ ] **Step 2: Run e2e**

Run: `cd ui && npx playwright test`
Expected: 7 passed.

- [ ] **Step 3: Version and README**

Set `desktop/package.json` `"version"` to `"0.6.0"`. In `README.md`'s bug-fix section add a short paragraph:

```md
**The bug screen.** Press **Bugs** in the top bar (or *Open full view* on a bug's card) to see one
bug end to end: where it is in the pipeline, what the agent is doing right now, everything that is
blocking it, and every assumption or open question the agent reported along the way — with the
approve / request-changes / merge actions on the same page. Plans, diffs and errors are rendered,
never shown as raw markdown. Each bug has its own link (`#/bugs/bt3`).
```

- [ ] **Step 4: Run everything**

Run: `npm test && (cd server && npx tsc -p tsconfig.json --noEmit) && (cd ui && npx tsc -p tsconfig.json --noEmit) && (cd ui && npx playwright test)`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add ui/e2e/bugfix.spec.ts desktop/package.json README.md
git commit -m "test(e2e): drive a bug fix from the bug screen; document it; 0.6.0"
```
