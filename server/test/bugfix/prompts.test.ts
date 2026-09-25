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
