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

  it("an approval opens the merge gate, and conflict opens a rebase", () => {
    expect(nextStage(at("monitoring"), { type: "review-approved" }))
      .toMatchObject({ stage: "approved", run: null, gate: { kind: "merge" } });
    expect(nextStage(at("monitoring"), { type: "conflicting" }))
      .toMatchObject({ stage: "rebase", run: "rebase" });
  });

  it("a PR closed without merging ends the task with a reason and no success", () => {
    const t = nextStage(at("monitoring"), { type: "pr-closed" });
    expect(t).toMatchObject({ stage: "done", run: null });
    expect(t.error).toMatch(/closed without merging/i);
  });

  it("refuses a monitoring event anywhere but monitoring", () => {
    const events: BugEvent[] = [
      { type: "review-changes-requested", comments: "x" },
      { type: "checks-failed", checks: "x" },
      { type: "review-approved" },
      { type: "conflicting" },
      { type: "pr-closed" },
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
