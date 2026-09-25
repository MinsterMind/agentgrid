import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../../src/start.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { nextStage } from "../../src/bugfix/stages.js";
import type { BugTask, TrackerIssue } from "../../src/bugfix/types.js";

describe("startServer with the bug-fix workflow", () => {
  it("exposes the bug routes in fake mode and seeds the bugfix role", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-"));
    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    try {
      const state = await (await fetch(`${running.url}/api/state`)).json();
      expect(state.roles.map((r: { name: string }) => r.name)).toContain("bugfix");
      expect(state.bugTasks).toEqual([]);
      const issues = await (await fetch(`${running.url}/api/bugfix/issues`)).json();
      expect(issues[0]).toMatchObject({ key: "FAKE-1" });                 // fake tracker
      const pre = await (await fetch(`${running.url}/api/bugfix/preflight?repo=${encodeURIComponent(home)}`)).json();
      expect(pre).toHaveProperty("ok");
    } finally { await running.close(); }
  });

  it("fails a task stranded mid-stage by an unclean shutdown, so it's retryable after restart", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-recover-"));

    // Seed the home directory with a bug task that was "working" when the server died:
    // created (stage "intake"), then dispatched into an AGENT_STAGES stage ("analyzing"),
    // exactly like `intake()` leaves one mid-flight. Built through BugTaskStore/nextStage,
    // not hand-rolled JSON, so this keeps working if the on-disk shape changes.
    const issue: TrackerIssue = { key: "REC-1", title: "Stuck bug", url: "https://example.invalid/REC-1",
      status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
    const seedBugs = new BugTaskStore(home);
    await seedBugs.init();
    const created = await seedBugs.create({
      issue, trackerProject: "REC", sourceRepo: "/tmp/repo", worktree: "/tmp/repo/.worktrees/bugfix-REC-1",
      branch: "bugfix/REC-1", baseBranch: "main", agentId: "ag-stuck", mergePolicy: "ask", mergeMethod: "squash",
    });
    const stranded = await seedBugs.apply(created.id, nextStage(created, { type: "stage-done" }));
    expect(stranded.stage).toBe("analyzing"); // sanity: really is an AGENT_STAGES stage, not a gate

    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    try {
      const task = await (await fetch(`${running.url}/api/bugtasks/${created.id}`)).json() as BugTask;
      expect(task.stage).toBe("failed");
      expect(task.error).toMatch(/restart/i);

      // Retryable: the stage machine accepts a retry from here and sends it back to the
      // stage it was stuck in — this is exactly what `retry()` needs to work again.
      const retryTransition = nextStage(task, { type: "retry" });
      expect(retryTransition.stage).toBe("analyzing");
      expect(retryTransition.run).toBe("analyzing");
    } finally { await running.close(); }
  });
});
