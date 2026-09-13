import { test, expect } from "@playwright/test";

test("spawn → assign → answer permission → ack", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("No agents yet")).toBeVisible();
  await page.getByRole("button", { name: "+ Spawn" }).click();
  await page.getByPlaceholder("/Users/you/project").fill("/tmp");
  await page.getByRole("button", { name: "Spawn", exact: true }).click();

  const tile = page.getByTestId(/^tile-/).first();
  await expect(tile).toHaveAttribute("data-state", "free");
  await tile.getByPlaceholder(/assign work/i).fill("say hello");
  await tile.getByPlaceholder(/assign work/i).press("Enter");

  await expect(tile).toHaveAttribute("data-state", "waiting");
  await expect(page).toHaveTitle("(1) AgentGrid");
  await expect(page.getByTestId("pending-permission")).toContainText("echo hi");
  await page.getByRole("button", { name: "Allow", exact: true }).click();

  await expect(tile).toHaveAttribute("data-state", "done");
  await expect(tile).toContainText("All done (fake).");
  await page.getByRole("button", { name: /Ack/ }).click();
  await expect(tile).toHaveAttribute("data-state", "free");
  await expect(page).toHaveTitle("AgentGrid");
});
