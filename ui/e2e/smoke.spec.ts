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

test("spawn dialog browses folders confined to the browse root", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "+ Spawn" }).click();
  const dialog = page.locator(".dialog");
  await expect(dialog.getByRole("button", { name: "⬆ up" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /myrepo/ })).toContainText("git");
  await dialog.getByRole("button", { name: "plain" }).click();            // descend into a non-repo folder
  await expect(dialog.getByText("No subfolders")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "⬆ up" })).toBeEnabled();
  await expect(dialog.locator(".crumb")).toHaveCount(2);                   // root + "plain", nothing above the root
  await dialog.getByRole("button", { name: "⬆ up" }).click();
  await dialog.getByRole("button", { name: /myrepo/ }).click();           // one click selects a repo
  await expect(page.getByPlaceholder("/Users/you/project")).toHaveValue(/\/myrepo$/);
  await dialog.getByRole("button", { name: "Spawn", exact: true }).click();
  await expect(page.getByTestId("tile-architect@myrepo")).toBeVisible();
});
