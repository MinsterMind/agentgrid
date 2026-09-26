import { describe, it, expect } from "vitest";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, parseFakePrScript } from "../../src/start.js";
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

  it("recovers a stuck task even when no tracker is configured (no BugFixEngine exists at all)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-recover-notracker-"));

    const issue: TrackerIssue = { key: "REC-2", title: "Stuck bug, no tracker", url: "https://example.invalid/REC-2",
      status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
    const seedBugs = new BugTaskStore(home);
    await seedBugs.init();
    const created = await seedBugs.create({
      issue, trackerProject: "REC", sourceRepo: "/tmp/repo", worktree: "/tmp/repo/.worktrees/bugfix-REC-2",
      branch: "bugfix/REC-2", baseBranch: "main", agentId: "ag-stuck-2", mergePolicy: "ask", mergeMethod: "squash",
    });
    const stranded = await seedBugs.apply(created.id, nextStage(created, { type: "stage-done" }));
    expect(stranded.stage).toBe("analyzing");

    // fake: false and no integrations.json at all — the server boots with no tracker
    // configured, so `bugStore.bugTasks`/`store.bugTasks` exist but no BugFixEngine does
    // (all /api/bugtasks* routes answer 501). Recovery must still have run.
    const running = await startServer({ home, port: 0, fake: false, log: () => {} });
    try {
      const state = await (await fetch(`${running.url}/api/state`)).json();
      const task = state.bugTasks.find((t: BugTask) => t.id === created.id);
      expect(task).toBeDefined();
      expect(task.stage).toBe("failed");
      expect(task.error).toMatch(/restart/i);
    } finally { await running.close(); }
  });

  it("recovers a task stuck at intake (crash between bugs.create() and the first advance())", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-recover-intake-"));

    const issue: TrackerIssue = { key: "REC-3", title: "Stuck at intake", url: "https://example.invalid/REC-3",
      status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
    const seedBugs = new BugTaskStore(home);
    await seedBugs.init();
    // A task freshly created by `bugs.create()` and never advanced — exactly what a crash
    // between that write and `engine.intake()`'s follow-up `advance()` call leaves behind.
    const created = await seedBugs.create({
      issue, trackerProject: "REC", sourceRepo: "/tmp/repo", worktree: "/tmp/repo/.worktrees/bugfix-REC-3",
      branch: "bugfix/REC-3", baseBranch: "main", agentId: "ag-stuck-3", mergePolicy: "ask", mergeMethod: "squash",
    });
    expect(created.stage).toBe("intake");

    const running = await startServer({ home, port: 0, fake: true, log: () => {} });
    try {
      const task = await (await fetch(`${running.url}/api/bugtasks/${created.id}`)).json() as BugTask;
      expect(task.stage).toBe("failed");
      expect(task.error).toMatch(/restart/i);

      // retry() must resume straight into analyzing — "intake" has no dispatchable prompt.
      const retryTransition = nextStage(task, { type: "retry" });
      expect(retryTransition.stage).toBe("analyzing");
      expect(retryTransition.run).toBe("analyzing");
    } finally { await running.close(); }
  });

  // N6: recoverStuckBugTasks runs unconditionally at startup, before server.listen — its
  // blast radius must stay "the bug workflow", never "the server won't start".
  it("still boots when startup recovery itself fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-bug-recover-fails-"));

    const issue: TrackerIssue = { key: "REC-4", title: "Stuck bug", url: "https://example.invalid/REC-4",
      status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
    const seedBugs = new BugTaskStore(home);
    await seedBugs.init();
    const created = await seedBugs.create({
      issue, trackerProject: "REC", sourceRepo: "/tmp/repo", worktree: "/tmp/repo/.worktrees/bugfix-REC-4",
      branch: "bugfix/REC-4", baseBranch: "main", agentId: "ag-stuck-4", mergePolicy: "ask", mergeMethod: "squash",
    });
    const stranded = await seedBugs.apply(created.id, nextStage(created, { type: "stage-done" }));
    expect(stranded.stage).toBe("analyzing");

    // Make the bugtasks directory unwritable, so recoverStuckBugTasks's own write (marking
    // this task "failed") throws — simulating any startup-recovery failure, without relying
    // on a particular internal error path.
    const bugtasksDir = path.join(home, "bugtasks");
    await chmod(bugtasksDir, 0o500);
    const logs: string[] = [];
    try {
      const running = await startServer({ home, port: 0, fake: true, log: m => logs.push(m) });
      try {
        // The server itself is up and answering, even though recovery failed.
        const state = await (await fetch(`${running.url}/api/state`)).json();
        expect(state.roles.map((r: { name: string }) => r.name)).toContain("bugfix");
        expect(logs.some(m => /recovery failed/i.test(m))).toBe(true);
      } finally { await running.close(); }
    } finally {
      await chmod(bugtasksDir, 0o700);   // restore, so cleanup of the tmp dir doesn't itself fail
    }
  });
});

describe("parseFakePrScript (AGENTGRID_FAKE_PR_SCRIPT)", () => {
  it("returns undefined when the env var is unset", () => {
    expect(parseFakePrScript(undefined)).toBeUndefined();
  });

  it("parses a valid JSON script into ScriptedStep[]", () => {
    const raw = JSON.stringify([{ after: 2, pr: { reviewDecision: "APPROVED" } }]);
    expect(parseFakePrScript(raw)).toEqual([{ after: 2, pr: { reviewDecision: "APPROVED" } }]);
  });

  it("fails loudly rather than silently running scriptless when the JSON is malformed", () => {
    expect(() => parseFakePrScript("{not json")).toThrow(/AGENTGRID_FAKE_PR_SCRIPT/);
  });

  it("fails loudly when the JSON parses but isn't an array", () => {
    expect(() => parseFakePrScript(JSON.stringify({ after: 2 }))).toThrow(/AGENTGRID_FAKE_PR_SCRIPT/);
  });
});
