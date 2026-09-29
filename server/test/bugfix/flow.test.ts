import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, type RunningServer } from "../../src/start.js";
import type { BugTask, DiffResult } from "../../src/bugfix/types.js";

const run = promisify(execFile);

/** A real repo with a commit and an origin remote — `intake` refuses a repo with no remote.
 *  The remote is a real local bare repo (no network) rather than an unreachable ssh URL, so a
 *  real `git push` — which the server issues itself once a feedback/rebase round is approved,
 *  regardless of fake mode — actually lands rather than failing on DNS. */
async function repoWithRemote(): Promise<string> {
  const bare = await mkdtemp(path.join(tmpdir(), "ag-flow-remote-"));
  await run("git", ["init", "--bare", "-b", "main", bare]);
  const dir = await mkdtemp(path.join(tmpdir(), "ag-flow-repo-"));
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# fixture\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "init"], { cwd: dir });
  await run("git", ["remote", "add", "origin", bare], { cwd: dir });
  await run("git", ["push", "-u", "origin", "main"], { cwd: dir });
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

      // Stage 3: approving the diff opens the PR. The server itself passes through
      // `creating-pr` — no agent, no CLI — before landing on `monitoring`. That stage is
      // a fast server stage (no agent dispatch to wait on), so rather than polling for it
      // — which could miss the window entirely — check the task's own durable history.
      await post<BugTask>(`${url}/api/bugtasks/${created.id}/approve`);
      const done = await until(url, created.id, "monitoring");
      expect(done.history.map(h => h.stage)).toContain("creating-pr");
      expect(done.pr).toMatchObject({ state: "OPEN" });
      expect(done.pr?.url).toBeTruthy();
      expect(done.error).toBeNull();
      // Proof the *server* created the PR, not an agent: the fake forge recorded exactly
      // one `createPr` call for this run.
      expect(running.fakeForge?.createPrCalls()).toBe(1);

      // With no script, every fake-forge read returns the same view, so every tick is a "nothing
      // differs" tick and produces no finding at all. `prCheckedAt` moving is therefore proof the
      // poll itself is reported and wired through — which is what the card's "Last checked" reads.
      const deadline = Date.now() + 5_000;
      let polled = await get<BugTask>(`${url}/api/bugtasks/${created.id}`);
      while (!polled.prCheckedAt && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
        polled = await get<BugTask>(`${url}/api/bugtasks/${created.id}`);
      }
      expect(polled.prCheckedAt).toBeTruthy();
    } finally {
      await running?.close();
    }
  }, 40_000);

  it("walks the Phase 2 loop offline: review → feedback round → push → approval → merge → done", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-flow2-home-"));
    const repo = await repoWithRemote();                 // helper already in this file
    let running: RunningServer | null = null;
    try {
      // AGENTGRID_FAKE_PR_SCRIPT drives the fake forge: each step applies once the given
      // number of getPr calls have been made, so the watcher's own polling advances the story.
      running = await startServer({ home, port: 0, fake: true, log: () => {},
        fakePrScript: [
          // `after: 2`, not 1: the watcher's very first poll happens as soon as the task
          // reaches `monitoring`, and a task's own store `stage` flips away from `monitoring`
          // synchronously the moment that first poll finds something — leaving no reliable
          // window in which `monitoring` itself could be observed if the very first call
          // already carried the finding. Call 1 is a stable no-op read (nothing differs from
          // the baseline PR, so nothing fires) that leaves `monitoring` resting for a full
          // backoff interval; call 2 is where the review lands.
          { after: 2, pr: { reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2026-09-26T09:30:00Z" },
            events: [{ kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "Name it properly.", at: "2026-09-26T09:30:00Z" }] },
          // The engine's own push-confirmation read (`doPush`'s `forge.getPr`, once the
          // feedback round is approved) is itself a `getPr` call and consumes slot 3 before
          // the watcher ever gets to see it — an approval landing there would be silently
          // absorbed into the push's own confirmation and never reach `decide()`. Slot 4 is
          // the watcher's first poll back in `monitoring` (a stable no-op, same reasoning as
          // above); slot 5 is where the approval actually lands.
          { after: 5, pr: { reviewDecision: "APPROVED", lastSeenEventAt: "2026-09-26T10:00:00Z" } },
        ] });
      const url = running.url;
      const created = await post<BugTask>(`${url}/api/bugtasks`, { issueRef: "FAKE-1", repo });

      // Phase 1 walk, unchanged.
      await until(url, created.id, "plan-review");
      await post(`${url}/api/bugtasks/${created.id}/approve`);
      await until(url, created.id, "diff-review");
      await post(`${url}/api/bugtasks/${created.id}/approve`);
      await until(url, created.id, "monitoring");

      // The watcher finds the review and a feedback round opens on its own.
      const gate = await until(url, created.id, "diff-review", 20_000);
      expect(gate.gate).toMatchObject({ reason: "feedback" });
      expect(gate.feedbackRounds).toBe(1);

      // Approving pushes (server-side) and returns to monitoring.
      await post(`${url}/api/bugtasks/${created.id}/approve`);
      await until(url, created.id, "monitoring", 20_000);

      // Then the watcher finds the approval, which opens the merge gate.
      const merge = await until(url, created.id, "approved", 20_000);
      expect(merge.gate).toMatchObject({ kind: "merge" });

      // Merging confirms, tears down and lands on done.
      await post(`${url}/api/bugtasks/${created.id}/approve`);
      const done = await until(url, created.id, "done", 20_000);
      expect(done.pr).toMatchObject({ state: "MERGED" });
      expect(done.error).toBeNull();

      // Dismiss removes it.
      const res = await fetch(`${url}/api/bugtasks/${created.id}`, { method: "DELETE" });
      expect(res.status).toBe(204);
    } finally { await running?.close(); }
  }, 90_000);
});
