import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Conflicts across PRs, offline. This spec runs its OWN fake-mode server: the shared one's fake forge
// plays a scripted review story (bugfix.spec) that would also land on this task. Here the fake forge
// just keeps the PR open, and the base branch is moved for real, in a real bare origin.
const PORT = 4813;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

test.beforeAll(async () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "ag-conflict-"));
  server = spawn("npx", ["tsx", "src/index.ts", "serve"], {
    cwd: path.resolve("../server"), stdio: "ignore",
    env: { ...process.env, HOME: tmp(), AGENTGRID_FAKE: "1", AGENTGRID_PORT: String(PORT), AGENTGRID_HOME: tmp(), AGENTGRID_BROWSE_ROOT: tmp() },
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("the conflict spec's server did not start");
});
test.afterAll(() => { server?.kill(); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("a merge elsewhere makes this PR conflict: the card says so, and Resolve rebases it for review", async ({ page, request }) => {
  test.setTimeout(120_000);
  const repo = execFileSync("sh", [path.resolve("e2e/fixture-repo.sh")], { encoding: "utf8" }).trim();
  const task = await (await request.post(`${BASE}/api/bugtasks`, { data: { issueRef: "FAKE-3", repo } })).json();
  await page.goto(`${BASE}/#/bugs/${task.id}`);
  const screen = page.getByTestId("bug-screen");

  // A freshly started server compiles on first use: the first agent stage can take a while.
  await expect.poll(async () => (await (await request.get(`${BASE}/api/bugtasks/${task.id}`)).json()).stage, { timeout: 90_000, intervals: [2000] }).toBe("plan-review");
  await screen.getByRole("button", { name: "Approve & implement" }).click({ timeout: 30_000 });
  // The fake fix carries its regression test (fake-fix.test.txt), so the diff gate isn't blocked.
  await expect(screen.getByTestId("tests-in-diff")).toContainText("fake-fix.test.txt", { timeout: 30_000 });
  await screen.getByRole("button", { name: "Create PR" }).click();
  await expect(screen.getByText(/Watching PR #\d+/)).toBeVisible({ timeout: 30_000 });

  // Someone else's change lands on main, rewriting the file this fix touches.
  const other = mkdtempSync(path.join(tmpdir(), "ag-other-"));
  execFileSync("git", ["clone", "-q", git(repo, "remote", "get-url", "origin"), other]);
  writeFileSync(path.join(other, "fake-fix.txt"), "a different fix that landed first\n");
  git(other, "add", "-A");
  git(other, "-c", "user.email=o@x.invalid", "-c", "user.name=Other", "commit", "-qm", "another fix");
  git(other, "push", "-q", "origin", "HEAD:main");

  // The ConflictWatcher notices without any forge call; the card says so and waits for permission.
  const gate = screen.getByTestId("gate-conflict");
  await expect(gate).toContainText("Conflicts with main", { timeout: 30_000 });
  await expect(gate).toContainText("fake-fix.txt");
  await expect(screen.getByRole("option").filter({ hasText: "FAKE-3" })).toContainText("Waiting on you");

  await gate.getByRole("button", { name: "Resolve conflict" }).click();
  // The rebase runs, then its diff waits for review — saying what conflicted.
  await expect(screen.getByTestId("conflicted-files")).toContainText("fake-fix.txt", { timeout: 30_000 });
});
