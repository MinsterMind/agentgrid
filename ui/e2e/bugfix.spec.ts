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
  await expect(panel.getByText("FAKE-1").first()).toBeVisible();
  await expect(page.getByTestId("bug-stage")).toContainText(/analyzing|plan-review|failed/);
});
