import { describe, it, expect } from "vitest";
import { nextStage } from "../../src/bugfix/stages.js";
import type { BugEvent, BugStage, BugTask } from "../../src/bugfix/types.js";

const task = (stage: BugStage, extra: Partial<BugTask> = {}): BugTask => ({
  id: "bt1",
  issue: { key: "PAY-1", title: "t", url: "u", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] },
  trackerProject: "PAY", sourceRepo: "/r", worktree: "/r/.worktrees/bugfix-PAY-1", branch: "bugfix/PAY-1",
  baseBranch: "main", agentId: "bugfix@r", stage, gate: null, mergePolicy: "ask", mergeMethod: "squash",
  pr: null, costUsd: 0, history: [], error: null, createdAt: "", updatedAt: "", feedbackRounds: 0, ...extra,
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
  it("approving the diff runs opening-pr, which dispatches creating-pr", () => {
    expect(nextStage(task("diff-review"), { type: "approve" })).toMatchObject({ stage: "opening-pr", run: "opening-pr" });
    expect(nextStage(task("opening-pr"), { type: "stage-done" })).toMatchObject({ stage: "creating-pr", run: null, gate: null });
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

  it("retry from a task that failed while sitting at a gate is refused, not dispatched", () => {
    // Not reachable today through nextStage itself (stage-failed now guards gates below),
    // but retry must not trust a hand-built/legacy history either: a gate stage is never
    // something `runStage` can dispatch a prompt for.
    const t = task("failed", { history: [{ stage: "plan-review", at: "", note: "" }] });
    expect(() => nextStage(t, { type: "retry" })).toThrow(/plan-review/);
  });

  it("retry resumes an intake-stuck task straight into analyzing, not by re-dispatching intake", () => {
    // A task recovered by startup recovery while still at "intake" (worktree/agent already
    // created, but the transition to analyzing never landed) has no prompt for "intake" —
    // resuming it must skip straight to the stage that actually runs.
    const t = task("failed", { history: [{ stage: "intake", at: "", note: "" }] });
    expect(nextStage(t, { type: "retry" })).toMatchObject({ stage: "analyzing", run: "analyzing", error: null });
  });

  it("stage-failed refuses to fail a task that is waiting on a human at a gate", () => {
    expect(() => nextStage(task("plan-review"), { type: "stage-failed", reason: "x" })).toThrow(/plan-review/);
    expect(() => nextStage(task("diff-review"), { type: "stage-failed", reason: "x" })).toThrow(/diff-review/);
  });
});

const at = (stage: BugStage, extra: Partial<BugTask> = {}): BugTask => task(stage, extra);

describe("Phase 2: the monitoring loop", () => {
  it("changes requested and failing checks both open a feedback round", () => {
    expect(nextStage(at("monitoring"), { type: "review-changes-requested", comments: "fix the leak" }))
      .toMatchObject({ stage: "review-feedback", run: "review-feedback", note: "fix the leak" });
    expect(nextStage(at("monitoring"), { type: "checks-failed", checks: "unit-tests" }))
      .toMatchObject({ stage: "review-feedback", run: "review-feedback", note: "unit-tests" });
  });

  it("an approval opens the merge gate; a conflict waits at its own gate (spec 2026-10-07 §4.2)", () => {
    expect(nextStage(at("monitoring"), { type: "review-approved" }))
      .toMatchObject({ stage: "approved", run: null, gate: { kind: "merge" } });
    expect(nextStage(at("monitoring"), { type: "conflicting" }))
      .toMatchObject({ stage: "conflict", run: null, gate: { kind: "conflict" } });
  });

  it("a PR closed without merging ends the task with a reason and no success", () => {
    const t = nextStage(at("monitoring"), { type: "pr-closed" });
    expect(t).toMatchObject({ stage: "done", run: null });
    expect(t.error).toMatch(/closed without merging/i);
    // The outcome is recorded explicitly, not left to be inferred from this message's wording
    // or from a PR view a race can stale.
    expect(t.outcome).toBe("closed");
  });

  it("records the merged outcome on the transition out of merging", () => {
    const t = nextStage(at("merging"), { type: "stage-done" });
    expect(t).toMatchObject({ stage: "done", run: null, outcome: "merged" });
  });

  it("refuses a monitoring event anywhere but monitoring", () => {
    const events: BugEvent[] = [
      { type: "review-changes-requested", comments: "x" },
      { type: "checks-failed", checks: "x" },
      { type: "review-approved" },
      { type: "pr-closed" },   // `conflicting` has its own rule: see "the conflict gate"
    ];
    for (const event of events) {
      expect(() => nextStage(at("implementing"), event)).toThrow(/only while monitoring/i);
    }
  });
});

describe("Phase 2: feedback and rebase land at the diff gate, then the server pushes", () => {
  it("a verified feedback round opens the diff gate, labelled", () => {
    expect(nextStage(at("review-feedback"), { type: "stage-done" }))
      .toMatchObject({ stage: "diff-review", run: null, gate: { kind: "diff", reason: "feedback" } });
    expect(nextStage(at("rebase"), { type: "stage-done" }))
      .toMatchObject({ stage: "diff-review", run: null, gate: { kind: "diff", reason: "rebase" } });
  });

  it("approving a feedback diff pushes; approving an implement diff opens the PR", () => {
    const feedback = at("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "feedback" } });
    expect(nextStage(feedback, { type: "approve" })).toMatchObject({ stage: "pushing", run: null });
    const implement = at("diff-review", { gate: { kind: "diff", openedAt: "t" } });
    expect(nextStage(implement, { type: "approve" })).toMatchObject({ stage: "opening-pr", run: "opening-pr" });
  });

  it("a successful push returns to monitoring", () => {
    expect(nextStage(at("pushing"), { type: "stage-done" })).toMatchObject({ stage: "monitoring", run: null });
  });

  it("requesting changes at a labelled diff gate re-runs that same stage", () => {
    const feedback = at("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "feedback" } });
    expect(nextStage(feedback, { type: "request-changes", text: "not quite" }))
      .toMatchObject({ stage: "review-feedback", run: "review-feedback", note: "not quite" });
    const rebase = at("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "rebase" } });
    expect(nextStage(rebase, { type: "request-changes", text: "redo" })).toMatchObject({ stage: "rebase", run: "rebase" });
  });
});

describe("Phase 2: the merge gate", () => {
  it("approving merges, and requesting changes sends it back to a feedback round", () => {
    expect(nextStage(at("approved"), { type: "approve" })).toMatchObject({ stage: "merging", run: null });
    expect(nextStage(at("approved"), { type: "request-changes", text: "one more thing" }))
      .toMatchObject({ stage: "review-feedback", run: "review-feedback", note: "one more thing" });
  });

  it("a confirmed merge ends the task", () => {
    expect(nextStage(at("merging"), { type: "stage-done" })).toMatchObject({ stage: "done", run: null });
  });

  it("still refuses stage-failed at a gate, including the new one", () => {
    expect(() => nextStage(at("approved"), { type: "stage-failed", reason: "x" })).toThrow(/waiting on a human/i);
  });

  it("a failed server stage is retryable", () => {
    const failed = at("failed", { history: [{ stage: "pushing", at: "t", note: "" }, { stage: "failed", at: "t", note: "" }] });
    expect(nextStage(failed, { type: "retry" })).toMatchObject({ stage: "pushing", run: null });
  });
});

it("an externally merged PR routes to the same merging stage", () => {
  expect(nextStage(at("monitoring"), { type: "pr-merged" })).toMatchObject({ stage: "merging", run: null });
  expect(() => nextStage(at("implementing"), { type: "pr-merged" })).toThrow(/only while monitoring/i);
});

describe("server-side PR creation", () => {
  it("a verified opening-pr hands off to the creating-pr server stage", () => {
    expect(nextStage(task("opening-pr"), { type: "stage-done" }))
      .toMatchObject({ stage: "creating-pr", run: null });
  });

  it("a created PR rests in monitoring", () => {
    expect(nextStage(task("creating-pr"), { type: "stage-done" }))
      .toMatchObject({ stage: "monitoring", run: null });
  });

  it("a failed creation is retryable as a server stage", () => {
    const failed = task("failed", { history: [
      { stage: "creating-pr", at: "t", note: "" }, { stage: "failed", at: "t", note: "" }] });
    expect(nextStage(failed, { type: "retry" })).toMatchObject({ stage: "creating-pr", run: null });
  });

  it("still refuses stage-failed at a gate, and creating-pr is not a gate", () => {
    expect(() => nextStage(task("diff-review"), { type: "stage-failed", reason: "x" })).toThrow(/waiting on a human/i);
    expect(nextStage(task("creating-pr"), { type: "stage-failed", reason: "boom" }))
      .toMatchObject({ stage: "failed", error: "boom" });
  });
});

// A PR opened outside AgentGrid for a task that failed while pushing or opening one.
describe("a pull request opened outside AgentGrid", () => {
  const failedAtPr = task("failed", { history: [{ stage: "creating-pr", at: "t", note: "" }, { stage: "failed", at: "t", note: "" }] });

  it("at the approved commit, is adopted straight into monitoring with a note naming it", () => {
    const t = nextStage(failedAtPr, { type: "pr-adopted", number: 7, reviewed: true });
    expect(t).toMatchObject({ stage: "monitoring", run: null, gate: null, error: null });
    expect(t.note).toMatch(/#7.*outside AgentGrid/);
  });

  it("with commits nobody reviewed here, opens the diff gate first", () => {
    const t = nextStage(failedAtPr, { type: "pr-adopted", number: 7, reviewed: false });
    expect(t).toMatchObject({ stage: "diff-review", run: null, gate: { kind: "diff", reason: "external" } });
    expect(t.note).toMatch(/#7/);
  });

  it("is only for a failed task", () => {
    expect(() => nextStage(task("monitoring"), { type: "pr-adopted", number: 7, reviewed: true })).toThrow(/failed/);
  });

  it("approving that gate pushes, like any reopened diff gate", () => {
    const atGate = task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "external" } });
    expect(nextStage(atGate, { type: "approve" })).toMatchObject({ stage: "pushing", run: null });
  });

  it("requesting changes there sends the agent to address them on the PR's branch", () => {
    const atGate = task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "external" } });
    expect(nextStage(atGate, { type: "request-changes", text: "drop the debug log" })).toMatchObject({ stage: "review-feedback", run: "review-feedback" });
  });
});

describe("the conflict gate", () => {
  const C = (returnTo: "monitoring" | "approved") => ({ conflict: { files: ["src/a.ts"], base: "develop", detectedAt: "", returnTo } });
  it("a conflict while resting opens the gate instead of rebasing on its own", () => {
    for (const from of ["monitoring", "approved"] as const) {
      const t = nextStage(task(from), { type: "conflicting", files: ["src/a.ts"], base: "develop" });
      expect(t).toMatchObject({ stage: "conflict", run: null, gate: { kind: "conflict" } });
      expect(t.note).toContain("src/a.ts");
    }
  });
  it("approve resolves; cleared returns where it was; a repeat does nothing", () => {
    expect(nextStage(task("conflict", C("monitoring")), { type: "approve" })).toMatchObject({ stage: "rebase", run: "rebase" });
    expect(nextStage(task("conflict", C("approved")), { type: "conflict-cleared" })).toMatchObject({ stage: "approved", run: null, gate: { kind: "merge" } });
    expect(nextStage(task("conflict", C("monitoring")), { type: "conflict-cleared" })).toMatchObject({ stage: "monitoring", run: null, gate: null });
    expect(nextStage(task("conflict", C("monitoring")), { type: "conflicting", files: ["b"] })).toMatchObject({ stage: "conflict", run: null });
  });
  // Review Focus 1
  it("conflict findings are refused mid-rebase, at the diff gate, and mid-fix", () => {
    for (const s of ["rebase", "diff-review", "implementing"] as const) {
      expect(() => nextStage(task(s), { type: "conflicting" })).toThrow();
      expect(() => nextStage(task(s), { type: "conflict-cleared" })).toThrow();
    }
  });
  it("merged or closed while in conflict ends as usual; request-changes has nothing to change", () => {
    expect(nextStage(task("conflict", C("monitoring")), { type: "pr-merged" })).toMatchObject({ stage: "merging" });
    expect(nextStage(task("conflict", C("monitoring")), { type: "pr-closed" })).toMatchObject({ stage: "done", outcome: "closed" });
    expect(() => nextStage(task("conflict", C("monitoring")), { type: "request-changes", text: "x" })).toThrow();
  });
});

describe("conflicts resolve themselves (spec 2026-10-09 §4)", () => {
  it("a conflict with auto-resolve on goes straight to the rebase", () => {
    for (const from of ["monitoring", "approved"] as const) {
      const t = nextStage(task(from), { type: "conflicting", files: ["a.ts"], base: "develop", auto: true });
      expect(t).toMatchObject({ stage: "rebase", run: "rebase", gate: null });
      expect(t.note).toMatch(/Conflicts with develop: a\.ts/);
    }
  });
  it("without auto it still waits at the conflict gate", () => {
    expect(nextStage(task("monitoring"), { type: "conflicting", files: ["a.ts"] })).toMatchObject({ stage: "conflict", gate: { kind: "conflict" } });
  });
});

describe("a feedback round with no change (final review I5)", () => {
  it("goes back to the merge gate when the round started there, else to watching", () => {
    const fromGate = task("review-feedback", { history: [{ stage: "monitoring", at: "a", note: "" }, { stage: "approved", at: "b", note: "" }, { stage: "review-feedback", at: "c", note: "" }] });
    expect(nextStage(fromGate, { type: "feedback-no-change", note: "n" })).toMatchObject({ stage: "approved", gate: { kind: "merge" }, note: "n" });
    const fromWatch = task("review-feedback", { history: [{ stage: "monitoring", at: "a", note: "" }, { stage: "review-feedback", at: "c", note: "" }] });
    expect(nextStage(fromWatch, { type: "feedback-no-change", note: "n" })).toMatchObject({ stage: "monitoring", gate: null });
    expect(() => nextStage(task("monitoring"), { type: "feedback-no-change", note: "n" })).toThrow();
  });
});
