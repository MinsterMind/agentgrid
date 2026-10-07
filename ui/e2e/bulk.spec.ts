import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Start several bugs together, offline, on this spec's own fake server (the shared one's fake forge
// plays bugfix.spec's scripted story). The fake tracker assigns FAKE-1 and FAKE-2 and records status moves.
const PORT = 4814;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

test.beforeAll(async () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "ag-bulk-"));
  server = spawn("npx", ["tsx", "src/index.ts", "serve"], {
    cwd: path.resolve("../server"), stdio: "ignore",
    env: { ...process.env, HOME: tmp(), AGENTGRID_FAKE: "1", AGENTGRID_PORT: String(PORT), AGENTGRID_HOME: tmp(), AGENTGRID_BROWSE_ROOT: tmp() },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("the bulk spec's server did not start");
});
test.afterAll(() => { server?.kill(); });

test("pick two bugs, start them together; their tickets move to In Progress", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await request.put(`${BASE}/api/integrations`, { data: { statusMap: { FAKE: { started: { transition: "Start Progress", to: "In Progress" } } } } });
  const repo = execFileSync("sh", [path.resolve("e2e/fixture-repo.sh")], { encoding: "utf8" }).trim();

  await page.goto(`${BASE}/#/bugs`);
  const screen = page.getByTestId("bug-screen");
  await screen.getByRole("button", { name: "Select all not started (2)" }).click({ timeout: 60_000 });
  const bulk = page.getByTestId("bulk-start");
  await bulk.getByLabel("Repo for FAKE").fill(repo);
  const start = bulk.getByRole("button", { name: "Start 2 fixes" });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-manojmali-MinsterMind-hrns/86e01a86-3942-42df-a509-b1f90fcdb800/scratchpad/bulk-panel.png" });
  await start.click();

  await expect(bulk.getByText("Started 2 of 2")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "/private/tmp/claude-501/-Users-manojmali-MinsterMind-hrns/86e01a86-3942-42df-a509-b1f90fcdb800/scratchpad/bulk-done.png" });

  // Both tasks exist, and the ticket's history says it moved.
  const tasks = await (await request.get(`${BASE}/api/bugtasks`)).json();
  expect(tasks.map((t: { issue: { key: string } }) => t.issue.key).sort()).toEqual(["FAKE-1", "FAKE-2"]);
  await expect.poll(async () => (await (await request.get(`${BASE}/api/bugtasks`)).json())
    .every((t: { history: Array<{ note: string }> }) => t.history.some(h => /Moved FAKE-\d to In Progress/.test(h.note))), { timeout: 20_000 }).toBe(true);
});
