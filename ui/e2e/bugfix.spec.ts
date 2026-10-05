import { test, expect } from "@playwright/test";

// The whole flow runs offline: a fake tracker offers the ticket, a fake agent does the minimum
// the server verifies at each stage, and a fake forge reports the pull request. Real git and the
// real stage machine are exercised — only the model, the tracker and the forge are substituted.
test("bug fix: launch, approve the plan, approve the diff, land on an open PR", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Fix a bug" }).click();

  const dialog = page.locator(".dialog");
  await expect(dialog.getByText("Fake bug for demos")).toBeVisible();
  await dialog.getByRole("button", { name: /FAKE-1/ }).click();
  await dialog.getByLabel("Repo").fill(process.env.AGENTGRID_E2E_REPO!);
  const start = dialog.getByRole("button", { name: "Start fixing" });
  await expect(start).toBeEnabled();                                  // preflight passed: real repo, real remote
  await start.click();

  // Launching opens the bug screen on the new fix: the whole workflow on one page.
  const bugScreen = page.getByTestId("bug-screen");
  await expect(bugScreen).toBeVisible();
  await expect(page).toHaveURL(/#\/bugs\/bt\d+$/);
  await expect(bugScreen.getByRole("heading", { level: 2 })).toContainText("FAKE-1");

  // Gate 1: the agent wrote a plan and the server verified it before opening this gate.
  const pipeline = bugScreen.getByRole("list", { name: "Pipeline" });
  await expect(pipeline.locator('[data-state="waiting"]')).toContainText("Plan review", { timeout: 30_000 });
  // The fake agent's assumptions arrived, questions first, and are part of what's blocking.
  const assumptions = bugScreen.getByRole("region", { name: /assumptions/i });
  await expect(assumptions.getByRole("listitem").first()).toContainText("Should the fix also add a regression test?");
  await expect(assumptions).toContainText("confined to fake-fix.txt");
  await expect(bugScreen.getByRole("region", { name: /blocking/i })).toContainText("1 question to answer before approving");
  // No markdown source on the plan.
  await expect(bugScreen.getByRole("heading", { name: "Root cause" })).toBeVisible();
  await expect(bugScreen.locator(".plan")).not.toContainText("##");
  await bugScreen.getByRole("button", { name: "Approve & implement" }).click();
  await expect(pipeline.locator('[data-state="waiting"]')).toContainText("Diff review", { timeout: 30_000 });

  // Back to the grid for the rest of the flow. Launching selected the bug's agent, so its side
  // panel is open, and it links back to the full view.
  await page.getByRole("button", { name: "Agents" }).click();
  const panel = page.getByTestId("bug-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("FAKE-1").first()).toBeVisible();
  await expect(panel.getByRole("link", { name: /open full view/i })).toHaveAttribute("href", /^#\/bugs\/bt\d+$/);

  // Gate 2: the fix is committed in the worktree, and the diff card shows what the server computed.
  await expect(page.getByTestId("bug-stage")).toHaveAttribute("data-stage", "diff-review", { timeout: 30_000 });
  await expect(panel.getByText("fake-fix.txt")).toBeVisible();
  await panel.getByRole("button", { name: /Create PR|Approve/ }).click();

  // The PR stage ran and the server confirmed an open pull request on the forge. Wait for the PR
  // itself, not for "monitoring": the fake watcher can find its review within one poll, so that
  // stage may come and go before the page is ever looked at.
  await expect(panel.getByRole("link", { name: /PR #\d+/ })).toBeVisible({ timeout: 30_000 });

  // The watcher finds a review on its own and a feedback round opens. The reason line exists only
  // on a reopened diff gate — the first diff gate already said "diff-review", so the stage alone
  // would pass before anything happened.
  await expect(panel.getByText(/reviewers asked for changes/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("bug-stage")).toHaveAttribute("data-stage", "diff-review");
  await panel.getByRole("button", { name: /Approve/ }).click();

  // The server pushes and the task goes back to monitoring, then the approval arrives.
  await expect(page.getByTestId("bug-stage")).toHaveAttribute("data-stage", "approved", { timeout: 30_000 });
  await panel.getByRole("button", { name: /^Merge/ }).click();

  await expect(page.getByTestId("bug-stage")).toHaveAttribute("data-stage", "done", { timeout: 30_000 });
  await expect(panel.getByText(/merged/i)).toBeVisible();
  await panel.getByRole("button", { name: /Dismiss/i }).click();
  await expect(panel).toBeHidden();
});
