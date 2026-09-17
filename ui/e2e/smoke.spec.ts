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
  await expect(dialog.getByRole("button", { name: "⬆ up" })).toHaveCount(0);   // collapsed by default
  await dialog.getByRole("button", { name: /show folder list/i }).click();
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

test("sessions panel: adopt a past session and assign to it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  const recent = page.getByTestId("sessions-recent");
  await expect(recent).toContainText("Earlier work (fake)");
  await recent.getByRole("button", { name: "Adopt into grid" }).click();
  const tile = page.locator(".tile.selected");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("🔗");
  await tile.getByPlaceholder(/assign work/i).fill("continue where we left off");
  await tile.getByPlaceholder(/assign work/i).press("Enter");
  await expect(tile).toHaveAttribute("data-state", "waiting");
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(tile).toHaveAttribute("data-state", "done");
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.getByTestId("sessions-recent")).toContainText("on grid as");
});

test("transcript view shows the full conversation for an agent", async ({ page }) => {
  await page.goto("/");
  const tile = page.getByTestId(/^tile-/).first();          // agent from the first test, already done+acked or free
  await tile.locator(".hd").click();
  await page.getByRole("button", { name: "Transcript" }).click();
  const tx = page.locator(".dialog.tx");
  await expect(tx).toBeVisible();
  await expect(tx).toContainText("transcript");
  await page.keyboard.press("Escape");
  await expect(tx).toHaveCount(0);
});

test("terminal tab embeds a live session in the side panel", async ({ page }) => {
  await page.goto("/");
  const tile = page.getByTestId(/^tile-/).first();
  await tile.locator(".hd").click();
  await page.getByRole("button", { name: "Terminal" }).click();
  const pane = page.getByTestId("terminal-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("● live");
  await expect(pane.locator(".xterm")).toContainText("AgentGrid fake terminal");
  await page.keyboard.type("hello from the browser");
  await page.keyboard.press("Enter");
  await expect(pane.locator(".xterm")).toContainText("hello from the browser");
  await page.getByRole("button", { name: "Details" }).click();
  await expect(pane).toHaveCount(0);
});
