import { describe, it, expect } from "vitest";
import path from "node:path";
import { detectStage } from "../../src/fake/agent.js";
import { renderStagePrompt } from "../../src/bugfix/prompts.js";
import type { BugTask } from "../../src/bugfix/types.js";

const presets = path.resolve("presets");
const task: BugTask = {
  id: "bt1",
  issue: { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: ["a"] },
  trackerProject: "PAY", sourceRepo: "/r/pay", worktree: "/r/pay/.worktrees/bugfix-PAY-42",
  branch: "bugfix/PAY-42", baseBranch: "main", agentId: "ag1", stage: "analyzing", gate: null,
  mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0, history: [], error: null,
  approvedHead: null, createdAt: "", updatedAt: "",
};
const ctx = { artifactsDir: "/a/bt1", planPath: "/a/bt1/plan.md", prBodyPath: "/a/bt1/pr-body.md" };

// These assertions are the contract between the stage presets and the fake agent. The fake
// has no channel to learn its stage other than the prompt it is handed, so if a preset is
// reworded past these markers, fake mode silently stops doing any work — which is exactly
// how the e2e came to assert a stage regex the very first state already satisfied.
describe("detectStage, against the real stage presets", () => {
  it("recognises the analyze prompt and finds the plan path", async () => {
    const prompt = await renderStagePrompt("analyzing", task, ctx, presets);
    expect(detectStage(prompt)).toEqual({ stage: "analyze", planPath: "/a/bt1/plan.md" });
  });

  it("recognises the implement prompt", async () => {
    const prompt = await renderStagePrompt("implementing", { ...task, stage: "implementing" }, ctx, presets);
    expect(detectStage(prompt)).toMatchObject({ stage: "implement" });
  });

  it("recognises the open-pr prompt and finds the PR body path", async () => {
    const prompt = await renderStagePrompt("opening-pr", { ...task, stage: "opening-pr" },
      { ...ctx, createPrCommand: "gh pr create --base main" }, presets);
    expect(detectStage(prompt)).toEqual({ stage: "open-pr", prBodyPath: "/a/bt1/pr-body.md" });
  });

  it("treats an ordinary agent prompt as 'other', so plain fake mode keeps its canned behaviour", () => {
    expect(detectStage("Please look at the failing test and tell me what you find.")).toEqual({ stage: "other" });
  });

  it("recognises the review-feedback and rebase prompts", async () => {
    const fb = await renderStagePrompt("review-feedback", { ...task, stage: "review-feedback" }, { ...ctx, note: "fix it" }, presets);
    expect(detectStage(fb)).toMatchObject({ stage: "review-feedback" });
    const rb = await renderStagePrompt("rebase", { ...task, stage: "rebase" }, ctx, presets);
    expect(detectStage(rb)).toMatchObject({ stage: "rebase" });
  });
});
