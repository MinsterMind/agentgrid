# Regression Tests That Stick, and Conflicts Across ~1000 PRs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Every bug fix names and proves its regression tests.
- AgentGrid notices conflicts across hundreds of open PRs without exhausting forge APIs, shows them
  on the card, and resolves them only with permission.
- Agent runs are capped.

**Architecture:**
- **Regression tests.** The plan gains a `## Regression tests` section, read into `task.plannedTests`.
  The diff's test files are recorded in `task.testsInDiff`, and the server refuses a diff-gate
  approve without tests unless a reason-bearing override exists for that head.
- **Conflicts.** A `ConflictWatcher` checks base tips with `git ls-remote`, fetches once per move,
  and runs `git merge-tree` per task branch. Its findings drive a new `conflict` gate.
- **Queue.** A `RunQueue` caps concurrent bug-fix agent stages.
- **Forge polling.** The PrWatcher sweeps per repo with a new `listOpenPrs` adapter method.

**Tech Stack:** Node/Express + TypeScript (server), React 19 (ui), vitest, Playwright, git CLI.

**Spec:** `docs/superpowers/specs/2026-10-07-regression-tests-and-conflicts-at-scale-design.md`

## Global Constraints

- **Release.** Ships together with 0.11.0 work on `feat/permissions-bugs-view` as **0.12.0**
  (`desktop/package.json`).
- **Test files.** These regexes on any changed path count as tests:
  - `/\.(test|spec)\.[^/]+$/`
  - `/(^|\/)test_[^/]+$/`
  - `/_test\.[^/]+$/`
  - `/[A-Za-z0-9]Tests?\.[^/]+$/`
  - `/(^|\/)(test|tests|__tests__|spec|specs)\//`
- **Conflicts.**
  - Detection never uses forge API calls. It uses `git ls-remote` and `git fetch` once per base move
    per repo, then `git merge-tree --write-tree --name-only origin/<base> origin/<branch>`, run from
    the task's worktree.
  - Exit 1 means conflict, exit 0 means clean, and anything else is unknown (no change).
  - A conflict never starts a rebase without an approve at the `conflict` gate.
  - A failed check never clears a conflict.
- **Run cap.** `maxConcurrentRuns`: default 4, minimum 1, maximum 32. It applies to bug-fix agent
  stages only, never to manual assignments.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019vk3Y8Lj3YYsuDjzfQ2MBB
  ```

## Review Focus

1. **A conflict check races a human Resolve or a merge.**
   - A `conflicting` finding arriving while the task is already at `rebase` or `diff-review` must be
     ignored.
   - A `conflict-cleared` finding after Resolve was pressed must not cancel the running rebase.

   Pinned in Task 4 (the stage machine refuses these events outside watched stages) and Task 6.
2. **The base moves again while a rebase runs.** After the rebase the task re-enters monitoring, and
   the next check sees the new conflict. Pinned in Task 6.
3. **Queue slots leak.** A stage that fails at dispatch, is cancelled while queued, or whose task is
   dismissed must free its slot (or leave the waiting list). Pinned in Task 7.
4. **The diff-gate override is per head.** An override given at head A must not let head B through.
   Pinned in Task 2.
5. **A PR disappears from the open list.** It must be looked up once (merged or closed), never read
   as "nothing changed". Pinned in Task 8.

---

### Task 1: The plan names its regression tests

**Files:**
- Modify:
  - `server/presets/stages/analyze.md` and `server/presets/stages/implement.md`;
  - `server/src/bugfix/engine.ts` (`verify` for analyzing; export `regressionTests`);
  - `server/src/bugfix/types.ts` (`plannedTests: string[]`), `server/src/bugfix/store.ts`
    (normalise, create);
  - `server/src/fake/agent.ts` (its PLAN gains a `## Regression tests` section).
- Test: `server/test/bugfix/engine.test.ts`, `server/test/bugfix/prompts.test.ts` (and update the
  snapshot after reading its diff).

**Interfaces:**
- Produces:
  - `export function regressionTests(plan: string): string[]`: the list items under a
    `## Regression tests` heading (any level 1–3, case-insensitive), skipping fenced code, until the
    next heading.
  - `BugTask.plannedTests: string[]`, normalised to `[]`.

- [ ] **Step 1: Failing tests**

```ts
// engine.test.ts
import { regressionTests } from "../../src/bugfix/engine.js";
describe("regression tests in the plan", () => {
  it("reads the list under the heading, ignoring code and stopping at the next heading", () => {
    const plan = "Verdict: change needed\n## Root cause\nx\n## Regression tests\n- `test/cart.test.ts` › totals match with a coupon — fails today: double discount\n* test/cart.test.ts › coupon applies once\n```\n- not a test\n```\n## Risks\n- none";
    expect(regressionTests(plan)).toEqual(["`test/cart.test.ts` › totals match with a coupon — fails today: double discount", "test/cart.test.ts › coupon applies once"]);
    expect(regressionTests("## Fix\n- a")).toEqual([]);
  });
  it("the analyze stage records the planned tests on the task", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "Verdict: change needed\n## Regression tests\n- test/a.test.ts › rotates once\n");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).plannedTests).toEqual(["test/a.test.ts › rotates once"]);
  });
});
```

Prompts test (append to the "base and no-change" describe):

```ts
it("the plan must name regression tests; the change step writes them first and proves fail→pass", async () => {
  const a = await renderStagePrompt("analyzing", task, ctx, presets);
  expect(a).toContain("## Regression tests"); expect(a).toMatch(/fails on today's code/i);
  const i = await renderStagePrompt("implementing", { ...task, stage: "implementing" }, ctx, presets);
  expect(i).toMatch(/write the plan's regression tests first/i); expect(i).toMatch(/fail.*before.*pass.*after/is);
});
```

- [ ] **Step 2: Run them.** Command: `cd server && npx vitest run test/bugfix/engine.test.ts -t "regression tests" test/bugfix/prompts.test.ts`.
  Expected: FAIL (`regressionTests` is not exported; the prompt text is missing).
- [ ] **Step 3: Implement.**
  - **`regressionTests`:**
    - iterate the lines, toggling `fence` on lines matching `` /^\s*(```|~~~)/ ``;
    - a heading `/^#{1,3}\s+regression tests\s*$/i` turns capture on, and any other heading turns it
      off;
    - when capturing and not in a fence, `/^\s*[-*]\s+(.+)$/` pushes the trimmed text.
  - **`verify(analyzing)`:** `await bugs.patch(task.id, { verdict: planVerdict(plan), plannedTests: regressionTests(plan) })`.
  - **`analyze.md`:** in step 4, after the verdict lines, add:
    ```
    Then these headings:
      - Root cause
      - Fix (files and what changes in each)
      - Regression tests — a list, one item per test: the test file › the case's name — what it asserts — why it fails on today's code. These are what stop this bug coming back; name real files in this repo. With "no change needed", name the existing test that already covers it (or say none exists).
      - Risks and anything you are unsure about
    ```
    This replaces the old "Test strategy" heading.
  - **`implement.md`:** steps become:
    ```
    1. Write the plan's regression tests first, and run them: they must fail, for the reason the plan gives.
    2. Make the change.
    3. Run the regression tests again — they must pass — then the project's whole test suite.
    4. Commit on {{branch}} with a message starting "{{issueKey}}: ".
    ```
    Summary line: `Finish with a 2–3 line summary, and list each regression test as "<test> — failed before, passes after".`
  - **The fake agent's PLAN:** append
    `\n## Regression tests\n- fake-fix.test.txt › the fake bug stays fixed — fails today: the fixture reproduces it\n`.
  - **Store:** `create` sets `plannedTests: []`, and `init` normalises `t.plannedTests ??= []`.
    Update the UI test fixtures that construct `BugTask` (`plannedTests: []`).
- [ ] **Step 4: Run it.** Expected: PASS. Update the prompts snapshot only after reading its diff.
  Run the full server suite.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): the plan names its regression tests; the change step proves them fail→pass`.

---

### Task 2: The server checks the diff for tests (blocker plus per-head override)

**Files:**
- Modify:
  - `server/src/bugfix/engine.ts` (`verify` for implementing / review-feedback / rebase, approve
    guard, `overrideTests`);
  - `server/src/bugfix/types.ts` (`testsInDiff: string[] | null`,
    `testOverride: { reason: string; at: string; head: string } | null`);
  - `server/src/bugfix/store.ts`;
  - `server/src/api/app.ts` (`POST /api/bugtasks/:id/override-tests`).
- Create: `server/src/bugfix/tests.ts` (`isTestFile`, `testFilesIn`).
- Test: `server/test/bugfix/tests.test.ts`, `server/test/bugfix/engine.test.ts`,
  `server/test/bugfix/api.test.ts`.

**Interfaces:**
- Produces:
  - `isTestFile(path: string): boolean` and `testFilesIn(paths: string[]): string[]`;
  - `engine.overrideTests(taskId: string, reason: string): Promise<BugTask>`:
    - only at `diff-review`;
    - stores `{reason, at, head: approvedHead}`;
    - appends a history note `Approved without a regression test: <reason>`;
    - then approves.
  - `engine.approve` at `diff-review` throws
    `Conflict("no regression test in this change — approve with a reason to override")` when
    `testsInDiff` is an empty array and there is no `testOverride` whose `head === approvedHead`.
    `null` (a record from before this field) does not block.

- [ ] **Step 1: Failing tests**

```ts
// tests.test.ts
import { describe, it, expect } from "vitest";
import { isTestFile, testFilesIn } from "../../src/bugfix/tests.js";
it.each([
  ["src/cart.test.ts", true], ["src/cart.spec.tsx", true], ["pkg/cart_test.go", true], ["tests/test_cart.py", true],
  ["src/CartTest.java", true], ["src/CartTests.cs", true], ["test/fixtures/a.json", true], ["src/__tests__/a.js", true], ["spec/a.rb", true],
  ["src/cart.ts", false], ["src/contest.ts", false], ["latest/x.ts", false], ["docs/testing.md", false], ["src/attest.ts", false],
])("%s → %s", (p, want) => expect(isTestFile(p)).toBe(want));
it("filters a diff's files", () => expect(testFilesIn(["a.ts", "a.test.ts"])).toEqual(["a.test.ts"]));
```

```ts
// engine.test.ts
describe("a change with no regression test", () => {
  async function atDiffGate(files: string[]) {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "Verdict: change needed\n## Regression tests\n- t\n");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    gitState.commits = 1; gitFake.git.diff = async () => ({ patch: "p", files: files.map(path => ({ path, additions: 1, deletions: 0 })), additions: 1, deletions: 0 });
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    return t;
  }
  it("records the diff's test files; with none, approving needs a reason", async () => {
    const t = await atDiffGate(["src/cart.ts"]);
    expect(bugs.get(t.id).testsInDiff).toEqual([]);
    await expect(engine.approve(t.id)).rejects.toThrow(/no regression test/);
    await expect(engine.overrideTests(t.id, "  ")).rejects.toThrow(/reason/);
    const done = await engine.overrideTests(t.id, "config-only change, covered by e2e");
    expect(done.stage).toBe("opening-pr");
    expect(done.testOverride).toMatchObject({ reason: "config-only change, covered by e2e", head: "a".repeat(40) });
    expect(done.history.some(h => /Approved without a regression test: config-only/.test(h.note))).toBe(true);
  });
  it("a change with a test file approves as before", async () => {
    const t = await atDiffGate(["src/cart.ts", "src/cart.test.ts"]);
    expect(bugs.get(t.id).testsInDiff).toEqual(["src/cart.test.ts"]);
    expect((await engine.approve(t.id)).stage).toBe("opening-pr");
  });
  // Review Focus 4
  it("an override counts only for the head it was given at", async () => {
    const t = await atDiffGate(["src/cart.ts"]);
    await bugs.patch(t.id, { testOverride: { reason: "r", at: "", head: "b".repeat(40) } });
    await expect(engine.approve(t.id)).rejects.toThrow(/no regression test/);
  });
});
```

  `atDiffGate` relies on `gitFake` exposing `.git`. If the existing fake's `diff` is defined on the
  `GitOps` instance, reassigning it as shown works; otherwise add a `state.diffFiles` hook to
  `fakeGit` and record a ruling.

  API test: `POST /api/bugtasks/bt1/override-tests` with no reason → 400. With a reason, it calls
  `engine.overrideTests` (via the fake engine's recorded calls).

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`tests.ts`:** the Global Constraints regexes.
  - **`verify`:** in each of the three diff-producing branches, after
    `const diff = …`, `await bugs.patch(task.id, { testsInDiff: testFilesIn(diff.files.map(f => f.path)) })`.
  - **`approve(taskId)`:** read the task. If `stage === "diff-review" && Array.isArray(t.testsInDiff) && t.testsInDiff.length === 0 && t.testOverride?.head !== t.approvedHead`,
    throw the Conflict. Then advance as before.
  - **`overrideTests`:** trim the reason (empty → `BadRequest("say why there is no regression test")`).
    Require `stage === "diff-review"` (else Conflict). Patch `testOverride` and append the history
    note: add `bugs.note(taskId, text)` if the store has no such helper (a history entry with the
    current stage). Then `this.advance(taskId, { type: "approve" })`.
  - **Store:** `testsInDiff: null` and `testOverride: null` on create; normalise in `init`.
  - **Route:** `app.post("/api/bugtasks/:id/override-tests", …)`. The reason must be a non-empty
    string, otherwise 400.
- [ ] **Step 4: Run the server suite.** Expected: PASS. Existing flow tests that approve a diff with
  no test file will now fail. Fix them by giving their fake diff a test file (the offline flow's fake
  agent writes `fake-fix.txt`: make it also write `fake-fix.test.txt`, which matches
  `/\.(test|spec)\.[^/]+$/`), and record a ruling.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): a diff without a regression test needs a reason to approve — per head`.

---

### Task 3: UI — planned tests at the plan gate; the no-test blocker and its override

**Files:**
- Modify: `ui/src/bugView.ts` (`blockersFor`), `ui/src/components/BugGates.tsx`, `ui/src/api.ts`
  (`overrideTests`), `ui/src/styles.css`.
- Test: `ui/test/bugView.test.ts`, `ui/test/BugPanel.test.tsx`.

**Interfaces:**
- Consumes: `BugTask.plannedTests`, `testsInDiff`, `testOverride`, `approvedHead`.
- Produces: `api.overrideTests(id, reason)` → `POST /api/bugtasks/:id/override-tests`.

- [ ] **Step 1: Failing tests.**
  - `blockersFor`:
    - at the plan gate with `verdict === null` and `plannedTests: []` →
      `{ kind: "gate", title: "The plan names no regression test" }`;
    - at the diff gate with `testsInDiff: []` and no override for `approvedHead` →
      `{ kind: "gate", title: "No regression test in this change" }`;
    - neither appears when tests exist, or when the override head matches.
  - BugPanel:
    - the plan gate shows the heading "Tests that will stop this coming back" and lists
      `plannedTests`;
    - the diff gate with `testsInDiff: []` disables "Approve & open PR", and shows
      "No regression test in this change" and a button **Approve without a test…**;
    - clicking it reveals a reason textarea (labelled "Why there is no regression test") and
      **Approve without a test**, which is disabled until the reason is non-blank;
    - submitting calls `api.overrideTests("bt1", reason)`;
    - the diff gate with `testsInDiff: ["src/a.test.ts"]` shows "Tests in this change: src/a.test.ts"
      and Approve is enabled.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the blockers, the plan-gate list (under the plan view), and the diff-gate
  test line, disabled Approve and override form. Use the existing `act(...)` helper.
- [ ] **Step 4: Run the UI suite and a typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(ui): regression tests on the plan and diff gates; overriding needs a reason`.

---

### Task 4: The Conflict gate in the stage machine

**Files:**
- Modify:
  - `server/src/bugfix/types.ts`:
    - `BugStage` adds `"conflict"`; `GateKind` adds `"conflict"`;
    - `WATCHED_STAGES` adds `"conflict"`; `GATE_STAGES` adds `"conflict"`;
    - `BugEvent` changes `conflicting` to `{ type: "conflicting"; files?: string[]; base?: string }`
      and adds `{ type: "conflict-cleared" }`;
    - `BugTask.conflict: { files: string[]; base: string; detectedAt: string; returnTo: "monitoring" | "approved" } | null`.
  - `server/src/bugfix/stages.ts`, `server/src/bugfix/engine.ts` (advanceLocked writes and clears
    `conflict`), `server/src/bugfix/store.ts` (normalise).
- Test: `server/test/bugfix/stages.test.ts`, `server/test/bugfix/engine.test.ts`.

**Interfaces:**
- Produces, in `nextStage`:
  - **`conflicting`:**
    - from `monitoring` or `approved` → `{ stage: "conflict", gate: { kind: "conflict" }, run: null, note: "Conflicts with <base>: <files>" }`;
    - from `conflict` → stay (`{ stage: "conflict", gate: task.gate, run: null, note: "" }`);
    - elsewhere → Conflict (only while a PR is resting).
  - **`conflict-cleared`:** from `conflict` → `task.conflict?.returnTo ?? "monitoring"`, with the
    gate `{kind:"merge"}` when returning to `approved`, otherwise null. Elsewhere → Conflict.
  - **`approve`:** at `conflict` → `go("rebase", "rebase")`.
  - **`request-changes`:** at `conflict` → Conflict. There is nothing to change; Cancel exists.
  - **`MONITORING_ONLY` events** are allowed at `conflict` too: `pr-merged` → merging, `pr-closed` →
    done/closed, `review-*` → ignored there (Conflict).
- The engine's `advanceLocked`:
  - on `conflicting` from a non-conflict stage, patches
    `conflict = { files, base: event.base ?? task.baseBranch, detectedAt: now, returnTo: task.stage }`;
  - on a repeat, patches `files` only;
  - on `conflict-cleared`, `pr-merged` or `pr-closed`, and on `approve` out of `conflict`, keeps
    `conflict` for the rebase prompt and clears it when the rebase lands at `diff-review`.
- The rebase prompt's `{{conflictFiles}}`: the conflicted files as a list, or "".

- [ ] **Step 1: Failing tests** (stages.test.ts, using its existing `task(stage, extra)` helper)

```ts
describe("the conflict gate", () => {
  it("a conflict while resting opens the gate instead of rebasing on its own", () => {
    for (const from of ["monitoring", "approved"] as const) {
      const t = nextStage(task(from), { type: "conflicting", files: ["src/a.ts"], base: "develop" });
      expect(t).toMatchObject({ stage: "conflict", run: null, gate: { kind: "conflict" } });
      expect(t.note).toContain("src/a.ts");
    }
  });
  it("approve resolves; cleared returns where it was; a repeat does nothing", () => {
    expect(nextStage(task("conflict"), { type: "approve" })).toMatchObject({ stage: "rebase", run: "rebase" });
    expect(nextStage(task("conflict", { conflict: { files: [], base: "develop", detectedAt: "", returnTo: "approved" } }), { type: "conflict-cleared" })).toMatchObject({ stage: "approved", gate: { kind: "merge" } });
    expect(nextStage(task("conflict", { conflict: { files: [], base: "develop", detectedAt: "", returnTo: "monitoring" } }), { type: "conflict-cleared" })).toMatchObject({ stage: "monitoring", gate: null });
    expect(nextStage(task("conflict"), { type: "conflicting", files: ["b"] })).toMatchObject({ stage: "conflict", run: null });
  });
  // Review Focus 1
  it("conflict findings are refused mid-rebase and at the diff gate", () => {
    for (const s of ["rebase", "diff-review", "implementing"] as const) {
      expect(() => nextStage(task(s), { type: "conflicting" })).toThrow();
      expect(() => nextStage(task(s), { type: "conflict-cleared" })).toThrow();
    }
  });
  it("merged or closed while in conflict ends as usual", () => {
    expect(nextStage(task("conflict"), { type: "pr-merged" })).toMatchObject({ stage: "merging" });
    expect(nextStage(task("conflict"), { type: "pr-closed" })).toMatchObject({ stage: "done", outcome: "closed" });
  });
});
```

  Engine test:
  - from a monitoring task (the `onMonitoringTask()` helper),
    `engine.onConflictFinding({ taskId, event: { type: "conflicting", files: ["a.ts"], base: "develop" } })`
    gives stage `conflict` with `conflict.returnTo === "monitoring"` and files `["a.ts"]`;
  - approve → `rebase`, and the dispatched prompt contains `a.ts`;
  - after the rebase lands at `diff-review`, `conflict` is null.

  Update the existing test that asserted `conflicting` → `rebase`. This is a deliberate spec change;
  record a ruling.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The types and `nextStage` cases as in Interfaces.
  - `onConflictFinding(f: { taskId: string; event: BugEvent })`: under `serial(taskId)`, try
    `advanceLocked`, and swallow a `Conflict` thrown by `nextStage`. A late finding for a task that
    moved on is not an error.
  - `PrWatcher.decide`'s `conflicting` stays (the forge flag), but now flows into the gate.
  - Add `{{conflictFiles}}` to `prompts.ts` vars:
    `task.conflict?.files.length ? "These files conflict:\n" + task.conflict.files.map(f => "- " + f).join("\n") : ""`.
    Insert `{{conflictFiles}}` in `rebase.md` after the first line.
  - The UI's exhaustive `stageLabel` and `pipelineFor`: add `conflict` ("Conflict"; pipeline step
    `monitor` with state `waiting`) so the UI typechecks. Full UI is in Task 9.
- [ ] **Step 4: Run both suites and both typechecks.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): a conflict waits at its own gate — resolving it needs your approve`.

---

### Task 5: Git — base tips, and the files a merge would conflict on

**Files:**
- Modify: `server/src/bugfix/git.ts`
- Test: `server/test/bugfix/git.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Remote tip of `branch` via `git ls-remote origin refs/heads/<branch>`; null when absent or unreadable. */
  remoteTip(repo: string, branch: string): Promise<string | null>;
  /** Files `git merge-tree --write-tree --name-only <base> <head>` reports as conflicting.
   *  [] = merges clean; null = could not tell (exit other than 0/1, missing ref, spawn error). */
  conflictFiles(dir: string, base: string, head: string): Promise<string[] | null>;
  ```

- [ ] **Step 1: Failing test** (real git: reuse `gitflowClone` from Task 0.10.1's tests)

```ts
describe("GitOps — conflicts without a forge", () => {
  it("names the files two branches conflict on, says [] when clean, null when it can't tell", async () => {
    const { clone, seed, origin } = await gitflowClone();
    // two bug branches off develop touching the same line; one merges
    for (const [b, text] of [["bugfix/A", "a\n"], ["bugfix/B", "b\n"]] as const) {
      await sh(seed, ["checkout", "-q", "-b", b, "develop"]); await writeFile(path.join(seed, "src.txt"), text);
      await sh(seed, ["commit", "-qam", b]); await sh(seed, ["push", "-q", origin, b]);
    }
    await sh(seed, ["checkout", "-q", "develop"]); await sh(seed, ["merge", "-q", "--no-ff", "-m", "merge A", "bugfix/A"]); await sh(seed, ["push", "-q", origin, "develop"]);
    await git.fetch(clone);
    expect(await git.conflictFiles(clone, "origin/develop", "origin/bugfix/B")).toEqual(["src.txt"]);
    expect(await git.conflictFiles(clone, "origin/develop", "origin/bugfix/A")).toEqual([]);
    expect(await git.conflictFiles(clone, "origin/develop", "origin/nope")).toBeNull();
    expect(await git.remoteTip(clone, "develop")).toBe((await sh(seed, ["rev-parse", "develop"])).trim());
    expect(await git.remoteTip(clone, "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (not a function).
- [ ] **Step 3: Implement.**
  - **`remoteTip`:** `ls-remote origin refs/heads/<b>`. The first token of the first line, or null
    (catch → null).
  - **`conflictFiles`:**
    - run `["merge-tree", "--write-tree", "--name-only", base, head]`;
    - on success → `[]`;
    - on error with `code === 1` → parse stdout. The error object must carry stdout: extend
      `defaultRun` to attach `stdout` to the rejection. Line 1 is the tree OID; the following
      non-empty lines up to the first blank line are file names; return them, deduplicated;
    - any other error → null.
- [ ] **Step 4: Run it.** Expected: PASS. Then run the full git test file.
- [ ] **Step 5: Commit** with the message
  `feat(git): remote tips and merge-tree conflict files — no forge needed`.

---

### Task 6: ConflictWatcher

**Files:**
- Create: `server/src/bugfix/conflicts.ts`, `server/test/bugfix/conflicts.test.ts`
- Modify: `server/src/start.ts` (wire it next to `PrWatcher`; fake cadence 500 ms),
  `server/src/bugfix/engine.ts` (nudge on `pr-merged`)

**Interfaces:**
- Consumes: `GitOps.remoteTip`, `fetch`, `conflictFiles` (Task 5); `engine.onConflictFinding`
  (Task 4).
- Produces:
  ```ts
  export class ConflictWatcher {
    constructor(deps: { bugs: BugTaskStore; git: GitOps; onFinding: (f: { taskId: string; event: BugEvent }) => Promise<void>; intervalMs?: number; poolSize?: number; onProblem?: (taskId: string, message: string | null) => Promise<void> });
    /** One pass over every repo with resting tasks. */ tick(): Promise<void>;
    /** Re-check this repo on the next tick even if its base hasn't moved. */ nudge(repo: string): void;
    start(): void; stop(): void;
  }
  ```
  - **Watched tasks:** stage in `monitoring | approved | conflict` and `pr` set.
  - **Per repo:**
    1. Find the distinct `baseBranch` values and call `remoteTip` for each.
    2. If any tip differs from the remembered one, or the repo was nudged, or the watched set gained
       a task since the last tick: call `fetch(repo)` once.
    3. For each watched task, run `conflictFiles(task.worktree, "origin/"+base, "origin/"+branch)`
       through a pool of `poolSize` (default 4).
    4. Map the result:
       - files non-empty and task not at `conflict` → `conflicting`;
       - `[]` and task at `conflict` → `conflict-cleared`;
       - `null` → nothing.
  - **Problems:** a fetch or tip failure calls `onProblem(taskId, "Couldn't check for conflicts: …")`
    for each of the repo's tasks, and changes nothing else. The next good pass calls
    `onProblem(id, null)`.

- [ ] **Step 1: Failing tests** (real git: one bare origin with `develop` and two bug branches; a
  `BugTaskStore` with two tasks in `monitoring` whose `worktree` is a clone and whose `pr` is set)

```ts
it("merging one branch makes the other conflict — found once, with its files", async () => { /* merge A into develop on the seed and push; tick → onFinding({ taskId: B, event: { type: "conflicting", files: ["src.txt"], base: "develop" } }) exactly once; A gets nothing */ });
it("is quiet when the base hasn't moved: no fetch, no findings", async () => { /* second tick: spy on git.fetch → not called; no findings */ });
it("a nudge re-checks without a base move", async () => { /* nudge(repo) → next tick fetches */ });
it("clears a conflict that went away", async () => { /* task at conflict whose branch was rebased by hand (push a rebased B) → conflict-cleared */ });
it("an unknown result changes nothing; a missing remote branch is skipped", async () => { /* conflictFiles → null via a task whose branch was never pushed */ });
// Review Focus 2
it("a base that moves again after a rebase is seen on the next pass", async () => { /* task back in monitoring after a rebase; push a second conflicting commit to develop; tick → conflicting again */ });
it("a fetch failure reports a problem and keeps the conflict", async () => { /* git.fetch throws → onProblem called with /Couldn't check for conflicts/, no conflict-cleared */ });
```

  Write each test body in full in the test file, from the real-git helpers in `git.test.ts`. Move
  `gitflowClone` into `server/test/helpers/gitRepos.ts` and import it from both files.

- [ ] **Step 2: Run them.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `conflicts.ts`:
  - remembered tips in a `Map<repo, Map<base, sha>>`;
  - a `seen` set of task ids per repo to detect new watchers;
  - a simple promise pool;
  - `setInterval(tick, intervalMs ?? 60_000)` with `unref`;
  - a tick guarded against overlap.
- [ ] **Step 4: Wire it.**
  - In `start.ts`, inside `wireBugFix` next to the `PrWatcher`:
    `new ConflictWatcher({ bugs: bugStore, git: new GitOps(), onFinding: f => engine.onConflictFinding(f), onProblem: (id, m) => engine.onConflictProblem(id, m), intervalMs: fake ? 500 : 60_000 })`.
    Stop it on rewire and close.
  - `engine.onConflictProblem` patches or clears a `conflictCheckError: string | null` field. Add it
    to the types and normalise it.
  - In the engine, after a `pr-merged` transition is applied, call
    `this.conflictNudge?.(task.sourceRepo)`. Set it with `engine.setConflictNudge(fn)` from
    `start.ts`.
- [ ] **Step 5: Run the server suite.** Expected: PASS.
- [ ] **Step 6: Commit** with the message
  `feat(bugfix): ConflictWatcher — base moves trigger one fetch and a merge-tree per PR`.

---

### Task 7: The run queue and `maxConcurrentRuns`

**Files:**
- Create: `server/src/bugfix/queue.ts`, `server/test/bugfix/queue.test.ts`
- Modify:
  - `server/src/bugfix/engine.ts` (dispatch through the queue, release on finish / failure / cancel /
    dismiss, resume on start);
  - `server/src/bugfix/types.ts` (`queuedAt: string | null`);
  - `server/src/bugfix/store.ts`;
  - `server/src/bugfix/integrations.ts` (`maxConcurrentRuns?: number`);
  - `server/src/api/app.ts` (accept `maxConcurrentRuns` in `PUT /api/integrations`, integer 1–32);
  - `recoverStuckBugTasks` (skip queued).
- Test: `queue.test.ts`, `server/test/bugfix/engine.test.ts`, `server/test/bugfix/api.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export class RunQueue {
    constructor(cap: () => number);
    /** True: start now (slot taken). False: added to the waiting list (FIFO by enqueue order). */ tryStart(taskId: string): boolean;
    /** Free taskId's slot; returns the next waiting task id to start (its slot already taken), or null. */ release(taskId: string): string | null;
    remove(taskId: string): void;   // leave the waiting list (cancel/dismiss)
    running(): string[]; waiting(): string[];
  }
  ```
  - **Engine.** In `advanceLocked`, `if (t.run)`:
    - `if (!this.queue.tryStart(task.id)) { await bugs.patch(task.id, { queuedAt: now }); return bugs.get(task.id); }`;
    - otherwise `runStage` as before.
  - **Releasing the slot.** Every path that ends the run calls `this.release(task.id)`:
    - `onAssignmentFinished` (on entry, before advancing);
    - the `runStage` failure catch;
    - `cancel`, when the task was running or queued;
    - `dismiss`.
  - **`release`** calls `queue.release`. If it returns `next`, it runs
    `this.serial(next, () => this.startQueued(next))`.
  - **`startQueued(id)`:** if the task is still in an agent stage with `queuedAt`, clear `queuedAt`
    and `runStage(task, task.stage)` (with the same failure handling as `advanceLocked`). Otherwise
    release the slot again.
  - **On attach:** `resumeQueued()` re-enqueues tasks with `queuedAt`, ordered by `queuedAt`, and
    starts as many as there are slots.

- [ ] **Step 1: Failing tests.**
  - **`queue.test.ts`:**
    - cap 2: `tryStart` a, b → true, c and d → false;
    - `release("a")` returns "c", and `running()` is `["b","c"]`;
    - `remove("d")` empties waiting;
    - `release` of an unknown id returns null;
    - lowering the cap to 1 with 2 running lets nothing start until both release.
  - **Engine (cap 1 via a fake integrations value):**
    - two intakes: the first dispatches; the second shows `stage: "analyzing"` with `queuedAt` set
      and no assignment;
    - finishing the first's stage starts the second (its assignment exists, `queuedAt` null).
  - **Review Focus 3:**
    - cancelling a queued task removes it, and the next one starts when a slot frees;
    - a dispatch that fails (manager.assign throws) frees the slot;
    - dismiss frees.
  - **Restart:** `recoverStuckBugTasks` leaves a queued task in its stage; a new engine's `attach()`
    resumes it.
  - **API:** `PUT /api/integrations { maxConcurrentRuns: 0 }` → 400; `8` is stored.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. The engine reads the cap via
  `() => this.capCache ?? 4`, refreshed from `integrations.read()` on attach and on every
  `PUT /api/integrations` (expose `engine.setMaxConcurrentRuns(n)` and call it from the route via
  `deps.bugs.engine`).
- [ ] **Step 4: Run the server suite.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): at most N bug-fix agents run at once; the rest queue, in order, across restarts`.

---

### Task 8: Forge polling per repo — `listOpenPrs`

**Files:**
- Modify:
  - `server/src/bugfix/forge/types.ts` (optional `listOpenPrs`);
  - `github.ts`, `bitbucket.ts`, `server/src/fake/forge.ts` (no list: keeps the fallback);
  - `server/src/bugfix/watcher.ts`.
- Test: `server/test/bugfix/forge/*.test.ts`, `server/test/bugfix/watcher.test.ts`.

**Interfaces:**
- Produces:
  - `listOpenPrs?(repoDir: string): Promise<{ prs: PrInfo[] } | { unavailable: string }>`;
    - **GitHub:** `gh pr list --state open --author @me --limit 1000 --json <FIELDS>` → `toPrInfo`
      each.
    - **Bitbucket:** `GET …/pullrequests?state=OPEN&pagelen=50&q=source.branch.name ~ "bugfix/"`,
      following `next` links → `toPrInfo(pr, null, null)`. Checks and mergeable are unknown in a
      listing.
  - **`PrWatcher.poll`**, when `forge.listOpenPrs` exists:
    1. group watched tasks by `sourceRepo`;
    2. per repo, apply the backoff (key `repo:<path>`) and call `listOpenPrs`;
    3. for each task, find its PR by number:
       - **missing** → `getPr` (merged or closed) → `tick` logic;
       - **present** and `updatedAt`, head and reviewDecision equal to the stored view → `onChecked`
         only;
       - **present but different** → `getPr` → `tick` logic (this fills checks and mergeable on
         Bitbucket).
    4. A listing failure → per-PR `tick` for that repo, this sweep only.

    Without `listOpenPrs`, polling is per PR, as today.

- [ ] **Step 1: Failing tests.**
  - **GitHub adapter (stubbed `run`):** `listOpenPrs` issues exactly one `gh pr list … --author @me --limit 1000` and maps 2 rows.
  - **Bitbucket (stubbed fetch):** follows `next` across 2 pages; the query contains
    `source.branch.name ~ "bugfix/"`.
  - **Watcher**, with a stub forge counting calls and 3 tasks in one repo:
    - one `listOpenPrs` and zero `getPr` when nothing changed;
    - one `getPr` for a task whose listed `updatedAt` moved;
    - **Review Focus 5:** one `getPr` for a task missing from the list, which yields `pr-merged`;
    - a listing failure → 3 `getPr`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the server suite.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(bugfix): poll pull requests per repo — one listing call, per-PR reads only for changes`.

---

### Task 9: UI — Conflict card, Resolve and Resolve all, Queued, Settings cap

**Files:**
- Modify:
  - `ui/src/bugView.ts`:
    - `listStatus` gives `conflict` → `"waiting"`;
    - `nowFor`: conflict → "Conflicts with <base>" with files as detail; queued →
      "Queued (n of m)";
    - `blockersFor`: conflict-check error;
  - `ui/src/components/BugGates.tsx` (the `conflict` gate panel: files, **Resolve conflict**,
    **Cancel task**);
  - `ui/src/components/BugScreen.tsx` (header **Resolve all N conflicts**; Queued in list status);
  - `ui/src/api.ts` (`resolveConflicts()`);
  - `server/src/api/app.ts` (`POST /api/bugtasks/resolve-conflicts` → approves every task at
    `conflict` through the engine; returns `{ ids }`);
  - `ui/src/components/SettingsDialog.tsx` ("Agents at once" number input 1–32, saved with the
    integrations);
  - `ui/src/components/AgentTile.tsx` (bug-stage chip `Conflict` in amber);
  - `ui/src/App.tsx` (notify "<KEY> conflicts with <base>" once per conflict entry).
- Test: `ui/test/bugView.test.ts`, `ui/test/BugPanel.test.tsx`, `ui/test/BugScreen.test.tsx`,
  `ui/src/components/SettingsDialog.test.tsx`, `server/test/bugfix/api.test.ts`.

**Interfaces:**
- Consumes: `BugTask.conflict`, `queuedAt`, `conflictCheckError`; `integrations.maxConcurrentRuns`.
- Produces: `api.resolveConflicts(): Promise<{ ids: string[] }>`.

- [ ] **Step 1: Failing tests.**
  - **bugView:**
    - `nowFor(conflict task)` headline is `Conflicts with develop`, and the detail lists the files;
    - for queued tasks (`queuedAt` set, three queued in state), `nowFor` reads `Queued (2 of 3)` for
      the second by `queuedAt`.

      Give `nowFor` an optional `queue?: { position: number; of: number }`, computed by `BugScreen`.
  - **BugPanel:** the conflict gate lists `src/a.ts`; **Resolve conflict** calls
    `approveBug("bt1")`.
  - **BugScreen:**
    - two tasks at `conflict` → the header shows **Resolve all 2 conflicts**;
    - clicking calls `resolveConflicts`;
    - with none, the button is absent.
  - **Settings:** "Agents at once" shows the saved value (default 4). Changing it to 8 and saving
    sends `maxConcurrentRuns: 8`, and 0 shows "Between 1 and 32".
  - **Server API:** `resolve-conflicts` approves only tasks at `conflict`, and returns their ids.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both suites and both typechecks.** Expected: PASS.
- [ ] **Step 5: Commit** with the message
  `feat(ui): conflicts on the card with Resolve and Resolve all; queued runs; the agents-at-once setting`.

---

### Task 10: End-to-end, version

**Files:**
- Create: `ui/e2e/conflicts.spec.ts`
- Modify: `desktop/package.json` (0.12.0)

- [ ] **Step 1: Write the e2e test** (fake mode, its own fixture repo so it can't race other specs):
  1. Run `sh e2e/fixture-repo.sh` via `execSync` for a fresh repo.
  2. `POST /api/bugtasks { issueRef: "FAKE-3", repo }`.
  3. Drive the gates through the UI:
     - approve the plan;
     - approve the diff (the fake change includes `fake-fix.test.txt`, so no blocker);
     - wait for "Watching PR".
  4. Make the base conflict: clone the fixture's bare origin into a temp dir, write a different
     `fake-fix.txt` on `main`, commit and push.
  5. Within 15 s, the bug card shows **Conflicts with main** listing `fake-fix.txt`, and the list
     status reads "Waiting on you".
  6. Click **Resolve conflict**. The pipeline shows the rebase running, then the diff gate with
     "Conflicted: fake-fix.txt".

  If the fake tracker needs FAKE-3 to fetch, add it alongside FAKE-2 (Task 11 of 0.11.0's plan
  added FAKE-2), and record a ruling.
- [ ] **Step 2: Run it.** Expected: FAIL until all the above lands; then PASS. Run the whole e2e suite.
- [ ] **Step 3: Bump the version.** Set 0.12.0, then run `npm test` and `cd ui && npm run e2e`.
  Expected: all pass.
- [ ] **Step 4: Commit** with the message `test(e2e): a conflict after a merge is shown and resolved with permission; 0.12.0`.
