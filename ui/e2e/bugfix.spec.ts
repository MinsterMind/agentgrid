import { test, expect } from "@playwright/test";

// The whole flow runs offline: a fake tracker offers the ticket, a fake agent does the minimum
// the server verifies at each stage, and a fake forge reports the pull request. Real git and the
// real stage machine are exercised — only the model, the tracker and the forge are substituted.
test("bug fix: launch, approve the plan, approve the diff, land on an open PR", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "🐞 Fix a bug" }).click();

  const dialog = page.locator(".dialog");
  await expect(dialog.getByText("Fake bug for demos")).toBeVisible();
  await dialog.getByRole("button", { name: /FAKE-1/ }).click();
  await dialog.getByLabel("Repo").fill(process.env.AGENTGRID_E2E_REPO!);
  const start = dialog.getByRole("button", { name: "Start fixing" });
  await expect(start).toBeEnabled();                                  // preflight passed: real repo, real remote
  await start.click();

  const panel = page.getByTestId("bug-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("FAKE-1").first()).toBeVisible();

  // Gate 1: the agent wrote a plan and the server verified it before opening this gate.
  await expect(page.getByTestId("bug-stage")).toContainText("plan-review", { timeout: 30_000 });
  await expect(panel.getByText("Root cause")).toBeVisible();
  await panel.getByRole("button", { name: /Approve/ }).click();

  // Gate 2: the fix is committed in the worktree, and the diff card shows what the server computed.
  await expect(page.getByTestId("bug-stage")).toContainText("diff-review", { timeout: 30_000 });
  await expect(panel.getByText("fake-fix.txt")).toBeVisible();
  await panel.getByRole("button", { name: /Create PR|Approve/ }).click();

  // The PR stage ran and the server confirmed an open pull request on the forge.
  await expect(page.getByTestId("bug-stage")).toContainText("monitoring", { timeout: 30_000 });
  await expect(panel.getByRole("link", { name: /#1|pull|PR/i }).first()).toBeVisible();
});
