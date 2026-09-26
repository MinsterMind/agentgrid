import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrWatcher, type PrFinding } from "../../src/bugfix/watcher.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import type { PrInfo, TrackerIssue } from "../../src/bugfix/types.js";
import type { ForgeAdapter, PrLookup, ReviewEvent } from "../../src/bugfix/forge/types.js";

const issue: TrackerIssue = { key: "W-1", title: "t", url: "u", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
const pr = (over: Partial<PrInfo> = {}): PrInfo => ({ number: 7, url: "https://x/pr/7", state: "OPEN",
  reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "abc123",
  lastSeenEventAt: "2026-09-26T09:00:00Z", ...over });

async function monitoringTask(): Promise<{ bugs: BugTaskStore; id: string }> {
  const bugs = new BugTaskStore(await mkdtemp(path.join(tmpdir(), "ag-watch-")));
  await bugs.init();
  const t = await bugs.create({ issue, trackerProject: "W", sourceRepo: "/r", worktree: "/r/.worktrees/bugfix-W-1",
    branch: "bugfix/W-1", baseBranch: "main", agentId: "ag1", mergePolicy: "ask", mergeMethod: "squash" });
  await bugs.patch(t.id, { stage: "monitoring", pr: pr() });
  return { bugs, id: t.id };
}

const forgeWith = (lookups: PrLookup[], events: ReviewEvent[] = []): ForgeAdapter => {
  let i = 0;
  return {
    name: "fake", authStatus: async () => ({ ok: true, message: "" }), createPrCommand: () => "",
    findPr: async () => null, merge: async () => ({ ok: true, message: "merged" }),
    getPr: async () => lookups[Math.min(i++, lookups.length - 1)],
    listReviewEvents: async () => events,
  };
};

const collect = () => { const found: PrFinding[] = []; return { found, onFinding: (f: PrFinding) => { found.push(f); } }; };

describe("PrWatcher", () => {
  it("reports changes-requested once, with the human comments", async () => {
    const { bugs, id } = await monitoringTask();
    const { found, onFinding } = collect();
    const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }],
      [{ kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "This leaks a handle.", at: "2026-09-26T09:30:00Z" }]);
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
    await w.poll();
    expect(found).toHaveLength(1);
    expect(found[0].event).toMatchObject({ type: "review-changes-requested" });
    expect((found[0].event as { comments: string }).comments).toContain("This leaks a handle.");
    expect((found[0].event as { comments: string }).comments).toContain("alice");
  });

  it("never wakes the agent for a bot comment", async () => {
    const { bugs, id } = await monitoringTask();
    const { found, onFinding } = collect();
    const forge = forgeWith([{ found: pr({ lastSeenEventAt: "2026-09-26T09:30:00Z" }) }],
      [{ kind: "comment", state: "", author: "ci-bot", isBot: true, body: "Build failed.", at: "2026-09-26T09:30:00Z" }]);
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
    await w.poll();
    expect(found[0].event).toBeNull();          // the card updates; nothing is dispatched
  });

  it("reports failing checks, approval, conflict, merge and closure", async () => {
    const cases: Array<[Partial<PrInfo>, string | null]> = [
      [{ checks: "FAILURE" }, "checks-failed"],
      [{ reviewDecision: "APPROVED" }, "review-approved"],
      [{ mergeable: "CONFLICTING" }, "conflicting"],
      [{ state: "MERGED" }, "pr-merged"],
      [{ state: "CLOSED" }, "pr-closed"],
    ];
    for (const [over, want] of cases) {
      const { bugs } = await monitoringTask();
      const { found, onFinding } = collect();
      const w = new PrWatcher({ bugs, forge: forgeWith([{ found: pr({ ...over, lastSeenEventAt: "2026-09-26T09:30:00Z" }) }]), onFinding, now: () => 0, jitter: ms => ms });
      await w.poll();
      expect(found[0].event?.type ?? null).toBe(want);
    }
  });

  it("prefers a conflict over an approval, because a conflicting PR cannot be merged", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    const w = new PrWatcher({ bugs, forge: forgeWith([{ found: pr({ reviewDecision: "APPROVED", mergeable: "CONFLICTING", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }]), onFinding, now: () => 0, jitter: ms => ms });
    await w.poll();
    expect(found[0].event).toMatchObject({ type: "conflicting" });
  });

  it("backs off while nothing changes and snaps back when something does", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    let clock = 0;
    const same: PrLookup = { found: pr() };                      // same lastSeenEventAt every time
    const forge = forgeWith([same]);
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => clock, jitter: ms => ms, baseMs: 100, ceilingMs: 400 });
    const spy = vi.spyOn(forge, "getPr");

    await w.poll();                     // first tick: due immediately
    expect(spy).toHaveBeenCalledTimes(1);
    await w.poll();                     // not due yet
    expect(spy).toHaveBeenCalledTimes(1);
    clock = 100; await w.poll();        // due at base
    clock = 200; await w.poll();        // NOT due — interval doubled to 200, next due at 300
    expect(spy).toHaveBeenCalledTimes(2);
    clock = 300; await w.poll();
    expect(spy).toHaveBeenCalledTimes(3);
    clock = 1_000_000; await w.poll();  // ceiling holds
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("treats an unreadable forge as no information: no event, and a warning after three failures", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    let clock = 0;
    const w = new PrWatcher({ bugs, forge: forgeWith([{ unavailable: "gh: could not connect" }]), onFinding,
      now: () => clock, jitter: ms => ms, baseMs: 10, warnAfterFailures: 3 });
    for (const t of [0, 10, 30]) { clock = t; await w.poll(); }
    expect(found.every(f => f.event === null)).toBe(true);
    expect(found.at(-1)?.unavailable).toMatch(/could not connect/);
    expect(found.filter(f => f.unavailable).length).toBe(1);      // warns once, at the threshold
  });

  it("only watches resting stages, and drops a task that leaves one", async () => {
    const { bugs, id } = await monitoringTask();
    const { found, onFinding } = collect();
    const forge = forgeWith([{ found: pr({ lastSeenEventAt: "2026-09-26T09:30:00Z" }) }]);
    const spy = vi.spyOn(forge, "getPr");
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
    await bugs.patch(id, { stage: "implementing" });
    await w.poll();
    expect(spy).not.toHaveBeenCalled();
    await bugs.patch(id, { stage: "approved" });
    await w.poll();
    expect(spy).toHaveBeenCalledTimes(1);      // approved is watched: a conflict can appear at the merge gate
  });

  it("does nothing at all without a forge or a PR", async () => {
    const { bugs, id } = await monitoringTask();
    const { found, onFinding } = collect();
    await new PrWatcher({ bugs, forge: null, onFinding, now: () => 0 }).poll();
    await bugs.patch(id, { pr: null });
    await new PrWatcher({ bugs, forge: forgeWith([{ found: pr() }]), onFinding, now: () => 0 }).poll();
    expect(found).toEqual([]);
  });
});
