import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Import a ticket whose PR is already open, then have a reviewer comment start a feedback round (spec 2026-10-09 §3, §5).
// Own fake server: its fake forge lists one open PR, on a branch that isn't bugfix/.
const PORT = 4815;
const BASE = `http://127.0.0.1:${PORT}`;
const OPEN_PRS = [{ number: 21, url: "https://example.invalid/pr/21", state: "OPEN", reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", headSha: null,
  lastSeenEventAt: "2026-10-09T09:00:00Z", headBranch: "feature/FAKE-1-login", baseBranch: "main", title: "FAKE-1 login" }];
let server: ChildProcess;

test.beforeAll(async () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "ag-import-"));
  server = spawn("npx", ["tsx", "src/index.ts", "serve"], {
    cwd: path.resolve("../server"), stdio: "ignore",
    env: { ...process.env, HOME: tmp(), AGENTGRID_FAKE: "1", AGENTGRID_PORT: String(PORT), AGENTGRID_HOME: tmp(), AGENTGRID_BROWSE_ROOT: tmp(), AGENTGRID_FAKE_OPEN_PRS: JSON.stringify(OPEN_PRS) },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("the import spec's server did not start");
});
test.afterAll(() => { server?.kill(); });

test("import a ticket whose PR is already open; a reviewer comment starts a round", async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Rounds at once. The server re-reads this every 30 s, so the round below may wait up to that long.
  await request.put(`${BASE}/api/integrations`, { data: { commentQuietMinutes: 0 } });
  const repo = execFileSync("sh", [path.resolve("e2e/fixture-repo.sh")], { encoding: "utf8" }).trim();
  execFileSync("sh", ["-c", `cd "${repo}" && git checkout -qb feature/FAKE-1-login && echo x > login.txt && git add -A && git commit -qm "FAKE-1: login" && git push -q origin feature/FAKE-1-login && git checkout -q main && git branch -qD feature/FAKE-1-login`]);

  await page.goto(`${BASE}/#/bugs`);
  await page.getByRole("button", { name: "Import tickets…" }).click();
  await page.getByLabel("Ticket keys").fill("FAKE-1");
  await page.getByLabel("Repo", { exact: true }).fill(repo);
  const go = page.getByRole("button", { name: "Import 1 ticket" });
  await expect(go).toBeEnabled({ timeout: 30_000 });
  await go.click();
  await expect(page.getByText(/Imported 1 of 1/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Watching the PR").first()).toBeVisible();

  const tasks = await (await request.get(`${BASE}/api/bugtasks`)).json();
  const t = tasks.find((x: { issue: { key: string } }) => x.issue.key === "FAKE-1");
  expect(t).toMatchObject({ stage: "monitoring", branch: "feature/FAKE-1-login", baseBranch: "main", pr: { number: 21 }, imported: true });

  await request.post(`${BASE}/api/fake/forge/events`, { data: { events: [{ kind: "comment", state: "", author: "reviewer", isBot: false, isSelf: false, body: "please add a test", at: new Date(Date.now() + 1000).toISOString() }] } });
  // A feedback round was dispatched for the comment (the count is kept even after the round moves on).
  await expect.poll(async () => (await (await request.get(`${BASE}/api/bugtasks/${t.id}`)).json()).feedbackRounds, { timeout: 90_000 }).toBeGreaterThanOrEqual(1);
});
