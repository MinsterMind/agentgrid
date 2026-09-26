import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { NotFound } from "../../src/store/store.js";
import type { TrackerIssue } from "../../src/bugfix/types.js";

const issue: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: ["a"] };
let home: string; let store: BugTaskStore; let events: unknown[];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "bt-"));
  store = new BugTaskStore(home);
  events = [];
  store.on("event", e => events.push(e));
  await store.init();
});

const mk = () => store.create({ issue, trackerProject: "PAY", sourceRepo: "/r/payments", worktree: "/r/payments/.worktrees/bugfix-PAY-42", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@payments", mergePolicy: "ask", mergeMethod: "squash" });

describe("BugTaskStore", () => {
  it("creates sequential tasks at stage intake, persists them, emits", async () => {
    const t = await mk();
    expect(t.id).toBe("bt1");
    expect(t).toMatchObject({ stage: "intake", gate: null, pr: null, error: null, costUsd: 0 });
    expect(t.feedbackRounds).toBe(0);
    expect(JSON.parse(await readFile(path.join(home, "bugtasks", "bt1.json"), "utf8"))).toEqual(t);
    expect(events).toEqual([{ type: "bugtask", task: t }]);
    expect((await mk()).id).toBe("bt2");
  });

  it("normalises a task written before feedbackRounds existed to 0 on load", async () => {
    const t = await mk();
    const raw = JSON.parse(await readFile(path.join(home, "bugtasks", `${t.id}.json`), "utf8"));
    delete raw.feedbackRounds;
    await writeFile(path.join(home, "bugtasks", `${t.id}.json`), JSON.stringify(raw));
    const reloaded = new BugTaskStore(home);
    await reloaded.init();
    expect(reloaded.get(t.id).feedbackRounds).toBe(0);
  });

  it("reloads from disk and continues the id counter", async () => {
    await mk();
    const again = new BugTaskStore(home); await again.init();
    expect(again.list().map(t => t.id)).toEqual(["bt1"]);
    const next = await again.create({ issue, trackerProject: "PAY", sourceRepo: "/r/p", worktree: "/w", branch: "b", baseBranch: "main", agentId: "a", mergePolicy: "ask", mergeMethod: "squash" });
    expect(next.id).toBe("bt2");
  });

  it("apply() moves the stage, records history and clears the error", async () => {
    const t = await mk();
    const moved = await store.apply(t.id, { stage: "analyzing", run: "analyzing", gate: null, note: "", error: null });
    expect(moved.stage).toBe("analyzing");
    expect(moved.history.at(-1)).toMatchObject({ stage: "analyzing", note: "" });
    const gated = await store.apply(t.id, { stage: "plan-review", run: null, gate: { kind: "plan", openedAt: "t" }, note: "n", error: null });
    expect(gated.gate).toEqual({ kind: "plan", openedAt: "t" });
    expect(gated.history.at(-1)!.note).toBe("n");
  });

  it("byAgent finds the live task for an agent and ignores terminal ones", async () => {
    const t = await mk();
    expect(store.byAgent("bugfix@payments")?.id).toBe(t.id);
    await store.apply(t.id, { stage: "done", run: null, gate: null, note: "", error: null });
    expect(store.byAgent("bugfix@payments")).toBeNull();
  });

  it("stores and reads artifacts under the task's directory", async () => {
    const t = await mk();
    await store.writeArtifact(t.id, "plan.md", "# Plan\nfix it");
    expect(await store.readArtifact(t.id, "plan.md")).toBe("# Plan\nfix it");
    expect(await store.readArtifact(t.id, "missing.md")).toBeNull();
    expect(store.dir(t.id)).toBe(path.join(home, "bugtasks", "bt1"));
  });

  it("unknown ids throw NotFound", () => {
    expect(() => store.get("nope")).toThrow(NotFound);
  });

  it("refuses artifact names and task ids that would escape the task directory", async () => {
    const t = await mk();
    await expect(store.writeArtifact(t.id, "../escape.md", "x")).rejects.toThrow(/invalid artifact name/);
    await expect(store.writeArtifact(t.id, "../../etc/cron.d/x", "x")).rejects.toThrow(/invalid artifact name/);
    await expect(store.readArtifact(t.id, "..")).rejects.toThrow(/invalid artifact name/);
    expect(() => store.dir("../../../etc")).toThrow(NotFound);
    await expect(store.readArtifact("../../etc", "passwd")).rejects.toThrow(NotFound);
    // the normal path still works
    await store.writeArtifact(t.id, "plan.md", "ok");
    expect(await store.readArtifact(t.id, "plan.md")).toBe("ok");
  });
});

/**
 * C1: every mutation is a read-modify-write, so two of them overlapping must not let the
 * loser write its stale snapshot over the winner's result. These are deterministic, not
 * timing-dependent: the second call is made synchronously, in the same microtask, while the
 * first one's write is still in flight — exactly the window `BugFixEngine`'s out-of-band
 * `patch()` calls (cost, PR) share with an `advance()`-chained `apply()` (cancel).
 */
describe("BugTaskStore concurrent mutations", () => {
  const cancel = { stage: "cancelled" as const, run: null, gate: null, note: "", error: null };

  it("a patch racing a cancel cannot resurrect the task", async () => {
    const t = await mk();
    const applied = store.apply(t.id, cancel);
    const patched = store.patch(t.id, { costUsd: 1.25 });   // no await between: the classic race
    await Promise.all([applied, patched]);
    expect(store.get(t.id).stage).toBe("cancelled");
    expect(store.get(t.id).costUsd).toBe(1.25);
    expect(JSON.parse(await readFile(path.join(home, "bugtasks", "bt1.json"), "utf8"))).toEqual(store.get(t.id));
  });

  it("a cancel racing a patch cannot be undone by the patch's stale snapshot", async () => {
    const t = await mk();
    const patched = store.patch(t.id, { costUsd: 1.25 });
    const applied = store.apply(t.id, cancel);
    await Promise.all([patched, applied]);
    expect(store.get(t.id)).toMatchObject({ stage: "cancelled", costUsd: 1.25 });
  });

  it("two overlapping applies both land, in order", async () => {
    const t = await mk();
    const a = store.apply(t.id, { stage: "analyzing", run: "analyzing", gate: null, note: "", error: null });
    const b = store.apply(t.id, cancel);
    await Promise.all([a, b]);
    const after = store.get(t.id);
    expect(after.stage).toBe("cancelled");
    expect(after.history.map(h => h.stage)).toEqual(["intake", "analyzing", "cancelled"]);
  });
});

describe("remove", () => {
  it("deletes the task file and its artifacts, and emits bugtask-removed", async () => {
    const t = await mk();
    await store.writeArtifact(t.id, "plan.md", "# Plan");
    await store.remove(t.id);
    expect(() => store.get(t.id)).toThrow(NotFound);
    await expect(readFile(path.join(home, "bugtasks", `${t.id}.json`), "utf8")).rejects.toThrow();
    await expect(store.readArtifact(t.id, "plan.md")).rejects.toThrow(NotFound);
    expect(events.at(-1)).toEqual({ type: "bugtask-removed", id: t.id });

    // gone from a reload too
    const reloaded = new BugTaskStore(home);
    await reloaded.init();
    expect(reloaded.list()).toEqual([]);
  });

  it("unknown ids throw NotFound without emitting", async () => {
    const before = events.length;
    await expect(store.remove("bt999")).rejects.toThrow(NotFound);
    expect(events.length).toBe(before);
  });
});
