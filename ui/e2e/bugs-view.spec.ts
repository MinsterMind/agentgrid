import { test, expect } from "@playwright/test";

// The combined bugs view, offline: the fake tracker assigns FAKE-1 and FAKE-2. FAKE-2 is never
// started by any spec, so it is always "Not started" here, whatever order the specs run in.
test("bugs view: every bug assigned to me, and a ticket that opens with an inline Start", async ({ page }) => {
  await page.goto("/#/bugs");
  const screen = page.getByTestId("bug-screen");
  const row = screen.getByRole("option").filter({ hasText: "FAKE-2" });
  await expect(row).toContainText("Not started");
  await row.click();
  await expect(page).toHaveURL(/#\/bugs\/ticket\/FAKE-2$/);
  const ticket = page.getByTestId("ticket-detail");
  await expect(ticket.getByRole("heading", { level: 2 })).toContainText("A second fake bug");
  await expect(ticket.getByText("it stops happening")).toBeVisible();          // acceptance criteria, rendered
  await ticket.getByLabel("Repo").fill(process.env.AGENTGRID_E2E_REPO!);
  await expect(ticket.getByText(/Remote found/)).toBeVisible();
  await expect(ticket.getByLabel("Branch from")).toBeVisible();
  await expect(ticket.getByRole("button", { name: "Start fixing" })).toBeEnabled();
});

// An embedded terminal's permission request, answered from Details. Fake mode has a test-only
// route that raises one (the real one comes from Claude Code's PermissionRequest hook).
test("a terminal's permission request is answered from the agent's details", async ({ page, request }) => {
  const agent = await (await request.post("/api/agents", { data: { role: "coder", repo: process.env.AGENTGRID_E2E_REPO!, displayName: "Perm" } })).json();
  await request.post("/api/fake/permission", { data: { agentId: agent.id, command: "echo from the fake terminal" } });
  await page.goto("/");
  const tile = page.getByTestId(`tile-${agent.id}`);
  await expect(tile.getByTestId("tile-state")).toContainText("Needs you");
  await tile.locator(".name").click();                                         // the request card itself answers, it doesn't select
  const card = page.getByTestId("side-panel").getByTestId("pending-permission");
  await expect(card).toContainText("echo from the fake terminal");
  await expect(card.getByRole("button", { name: "Always allow Bash(echo:*)" })).toBeVisible();
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByTestId("side-panel").getByTestId("pending-permission")).toHaveCount(0);
  await expect(tile.getByTestId("tile-state")).toContainText("Idle");
});
