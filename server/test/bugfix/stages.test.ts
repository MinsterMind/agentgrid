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
