import { test, expect } from "@playwright/test";

// Runs first so the server has no agents yet (Playwright runs files alphabetically within a worker).
test("first run → create an agent → it appears on the grid", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("side by side");
  await page.getByRole("button", { name: "Create an agent" }).click();
  await page.getByPlaceholder("/Users/you/project").fill("/tmp");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId(/^tile-/).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
});
