import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, type RunningServer } from "../../src/start.js";
import type { BugTask, DiffResult } from "../../src/bugfix/types.js";

const run = promisify(execFile);

/** A real repo with a commit and an origin remote — `intake` refuses a repo with no remote. */
async function repoWithRemote(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ag-flow-repo-"));
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# fixture\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "init"], { cwd: dir });
  await run("git", ["remote", "add", "origin", "git@example.invalid:acme/fixture.git"], { cwd: dir });
  return dir;
}

const get = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>;
const post = async <T>(url: string, body?: unknown): Promise<T> => {
  const res = await fetch(url, { method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
};

/** Poll the task until it reaches `stage`, failing with the stage it actually got stuck on. */
async function until(url: string, id: string, stage: BugTask["stage"], ms = 15_000): Promise<BugTask> {
  const deadline = Date.now() + ms;
  let last: BugTask | null = null;
  while (Date.now() < deadline) {
    last = await get<BugTask>(`${url}/api/bugtasks/${id}`);
    if (last.stage === stage) return last;
    if (last.stage === "failed" && stage !== "failed") break;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`task never reached ${stage}: stage=${last?.stage} error=${last?.error ?? "none"}`);
}

describe("the whole bug-fix flow, offline in fake mode", () => {
  it("walks intake → analyze → plan gate → implement → diff gate → open-PR → monitoring", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-flow-home-"));
    const repo = await repoWithRemote();
    let running: RunningServer | null = null;
    try {
      running = await startServer({ home, port: 0, fake: true, log: () => {} });
      const url = running.url;

      // The fake tracker offers one issue; launch a task against the real repo.
      const issues = await get<{ key: string }[]>(`${url}/api/bugfix/issues`);
      expect(issues[0].key).toBe("FAKE-1");

      const created = await post<BugTask>(`${url}/api/bugtasks`, { issueRef: "FAKE-1", repo });
      expect(created.stage).not.toBe("failed");

      // Stage 1: the agent writes a plan, the server verifies it, the plan gate opens.
      const planned = await until(url, created.id, "plan-review");
      expect(planned.gate).toMatchObject({ kind: "plan" });
      const plan = await get<{ markdown: string }>(`${url}/api/bugtasks/${created.id}/plan`);
      expect(plan.markdown.trim().length).toBeGreaterThan(0);

      // Stage 2: approving dispatches the fix; the server verifies real commits and computes the diff.
      await post<BugTask>(`${url}/api/bugtasks/${created.id}/approve`);
      const implemented = await until(url, created.id, "diff-review");
      expect(implemented.gate).toMatchObject({ kind: "diff" });
      const diff = await get<DiffResult>(`${url}/api/bugtasks/${created.id}/diff`);
      expect(diff.files.length).toBeGreaterThan(0);
      expect(diff.additions).toBeGreaterThan(0);
      expect(diff.patch).toContain("diff --git");

      // Stage 3: approving the diff opens the PR; the server confirms it is really open.
      await post<BugTask>(`${url}/api/bugtasks/${created.id}/approve`);
      const done = await until(url, created.id, "monitoring");
      expect(done.pr).toMatchObject({ state: "OPEN" });
      expect(done.pr?.url).toBeTruthy();
      expect(done.error).toBeNull();
    } finally {
      await running?.close();
    }
  }, 40_000);
});
