import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrWatcher, type PrFinding } from "../../src/bugfix/watcher.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import type { BugTask, PrInfo, TrackerIssue } from "../../src/bugfix/types.js";
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

  it("reports a head move even when lastSeenEventAt doesn't change, since no event represents a push", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    // Same lastSeenEventAt as the stored PR (pr()'s default) — only headSha differs, as if
    // the forge's updatedAt didn't move but the branch head did.
    const forge = forgeWith([{ found: pr({ headSha: "def456" }) }]);
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
    await w.poll();
    expect(found).toHaveLength(1);
    expect(found[0].pr?.headSha).toBe("def456");
  });

  it("keeps backing off through a bare lastSeenEventAt bump with no state change (bot noise)", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    let clock = 0;
    let tick = 0;
    // Every call bumps lastSeenEventAt (as a bot comment would) but never touches any state
    // field — checks/reviewDecision/mergeable/state/headSha all stay exactly as stored.
    const forge: ForgeAdapter = {
      name: "fake", authStatus: async () => ({ ok: true, message: "" }), createPrCommand: () => "",
      findPr: async () => null, merge: async () => ({ ok: true, message: "merged" }),
      getPr: async () => ({ found: pr({ lastSeenEventAt: `2026-09-26T09:${String(30 + tick++).padStart(2, "0")}:00Z` }) }),
      listReviewEvents: async () => [],
    };
    const spy = vi.spyOn(forge, "getPr");
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => clock, jitter: ms => ms, baseMs: 100, ceilingMs: 400 });

    await w.poll();                    // tick1 at t=0: reported (timestamp moved), backoff still grows
    expect(spy).toHaveBeenCalledTimes(1);
    clock = 100; await w.poll();       // due at base
    expect(spy).toHaveBeenCalledTimes(2);
    clock = 200; await w.poll();       // NOT due — interval kept doubling to 200 despite two "changes"
    expect(spy).toHaveBeenCalledTimes(2);
    clock = 300; await w.poll();
    expect(spy).toHaveBeenCalledTimes(3);
    // Every tick still produced a finding (the card needs the fresh lastSeenEventAt) —
    // reporting and backoff-reset are decided independently.
    expect(found.length).toBe(3);
    expect(found.every(f => f.event === null)).toBe(true);
  });

  it("snaps an elevated interval back to base on a genuine state change, not just any change", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    let clock = 0;
    const forge = forgeWith([
      { found: pr() },                                                              // no change
      { found: pr() },                                                              // no change again: interval keeps doubling
      { found: pr({ checks: "FAILURE", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }, // genuine state change
    ]);
    const spy = vi.spyOn(forge, "getPr");
    const w = new PrWatcher({ bugs, forge, onFinding, now: () => clock, jitter: ms => ms, baseMs: 100, ceilingMs: 400 });

    await w.poll();                    // t=0: no change, dueAt=100, interval grows to 200
    clock = 100; await w.poll();       // due; no change, dueAt=300, interval grows to 400
    clock = 300; await w.poll();       // due; state change -> checks-failed, resets to base
    expect(spy).toHaveBeenCalledTimes(3);
    expect(found.at(-1)?.event).toMatchObject({ type: "checks-failed" });
    clock = 399; await w.poll();       // not due yet if truly reset to base (400), not the elevated 700
    expect(spy).toHaveBeenCalledTimes(3);
    clock = 400; await w.poll();       // due exactly at base — proves the snap-back, not the elevated interval
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

  // I2/I3: a tick that reads the forge cleanly and finds nothing different produces no finding —
  // there is nothing to report about the PR. But the poll itself is news: it is what "Last
  // checked" means, and it is the evidence that a "couldn't reach the forge" note is stale.
  it("reports a clean tick that changed nothing, so the poll time and a recovery are not lost", async () => {
    const { bugs } = await monitoringTask();
    const { found, onFinding } = collect();
    const checked: Array<[string, string]> = [];
    const w = new PrWatcher({ bugs, forge: forgeWith([{ found: pr() }]), onFinding,
      onChecked: (id, at) => { checked.push([id, at]); }, now: () => 1_000, jitter: ms => ms });
    await w.poll();
    expect(found).toEqual([]);                       // nothing about the PR differs
    expect(checked).toEqual([["bt1", new Date(1_000).toISOString()]]);
  });

  it("does nothing at all without a forge or a PR", async () => {
    const { bugs, id } = await monitoringTask();
    const { found, onFinding } = collect();
    await new PrWatcher({ bugs, forge: null, onFinding, now: () => 0 }).poll();
    await bugs.patch(id, { pr: null });
    await new PrWatcher({ bugs, forge: forgeWith([{ found: pr() }]), onFinding, now: () => 0 }).poll();
    expect(found).toEqual([]);
  });
  /**
   * The same bug as C1, on the other event that routes to a feedback round. A standing
   * `checks: "FAILURE"` is held until CI runs again, so the failure alone does not say the round
   * is unanswered. The mechanism rejected for reviews is the right one here: a review can arrive
   * without the head moving, but a FIX for failing checks always moves the head.
   */
  describe("standing failing checks", () => {
    async function failingTask(over: Partial<BugTask> = {}) {
      const { bugs, id } = await monitoringTask();
      await bugs.patch(id, { pr: pr({ checks: "FAILURE" }), ...over });
      return { bugs, id };
    }

    it("dispatches for a PR that arrives already failing, with no round recorded yet", async () => {
      // Nothing has been dispatched for this task, so the red build IS news — this is the case a
      // "only when checks moved TO failure" dedupe would silently never dispatch for, since the
      // stored view is already FAILURE the first time the watcher looks.
      const { bugs } = await failingTask();
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ checks: "FAILURE", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }]);
      await new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms }).poll();
      expect(found[0].event).toMatchObject({ type: "checks-failed", headSha: "abc123" });
    });

    it("does not re-dispatch for a bot comment while the build stays red at the same head", async () => {
      const { bugs } = await failingTask({ checksRoundHead: "abc123" });
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ checks: "FAILURE", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }],
        [{ kind: "comment", state: "", author: "ci-bot", isBot: true, body: "Build failed.", at: "2026-09-26T09:30:00Z" }]);
      await new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms }).poll();
      expect(found).toHaveLength(1);
      expect(found[0].event).toBeNull();
    });

    it("dispatches again when the build is still failing at a NEW head — that is new information", async () => {
      const { bugs } = await failingTask({ checksRoundHead: "abc123" });
      const { found, onFinding } = collect();
      // The round pushed a fix, so the head moved; CI ran again and is still red.
      const forge = forgeWith([{ found: pr({ checks: "FAILURE", headSha: "def456", lastSeenEventAt: "2026-09-26T09:45:00Z" }) }]);
      await new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms }).poll();
      expect(found[0].event).toMatchObject({ type: "checks-failed", headSha: "def456" });
    });

    it("dispatches when the adapter reports no head at all, rather than suppressing on absent evidence", async () => {
      const { bugs } = await failingTask({ checksRoundHead: "abc123" });
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ checks: "FAILURE", headSha: null, lastSeenEventAt: "2026-09-26T09:45:00Z" }) }]);
      await new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms }).poll();
      expect(found[0].event).toMatchObject({ type: "checks-failed" });
    });
  });

  /**
   * C1: a standing CHANGES_REQUESTED is held by GitHub until a reviewer re-reviews, so the
   * decision alone is not evidence that THIS review is unanswered. Each of these four cases
   * pins one half of that: only a new non-bot review/comment since the PR view we already
   * have may dispatch a round.
   */
  describe("a standing CHANGES_REQUESTED", () => {
    /** Task already sitting on a CHANGES_REQUESTED view — i.e. round 1 has been answered
     *  (or is being waited on) and the decision has simply not been withdrawn. */
    async function standingTask() {
      const { bugs, id } = await monitoringTask();
      await bugs.patch(id, { pr: pr({ reviewDecision: "CHANGES_REQUESTED" }) });
      return { bugs, id };
    }

    it("does not dispatch for a bot comment that only bumps lastSeenEventAt", async () => {
      const { bugs } = await standingTask();
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2026-09-26T09:30:00Z" }) }],
        [{ kind: "comment", state: "", author: "ci-bot", isBot: true, body: "Build failed.", at: "2026-09-26T09:30:00Z" }]);
      const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
      await w.poll();
      expect(found).toHaveLength(1);
      expect(found[0].event).toBeNull();          // the card updates; no round is dispatched
    });

    it("does not dispatch when only the checks moved (the server's own push re-ran CI)", async () => {
      const { bugs } = await standingTask();
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", checks: "PENDING" }) }], []);
      const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
      await w.poll();
      expect(found[0].event).toBeNull();
    });

    it("does dispatch when a new human review lands with the decision still standing", async () => {
      const { bugs } = await standingTask();
      const { found, onFinding } = collect();
      const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2026-09-26T10:00:00Z" }) }],
        [{ kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "Still leaks.", at: "2026-09-26T10:00:00Z" }]);
      const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
      await w.poll();
      expect(found[0].event).toMatchObject({ type: "review-changes-requested" });
      expect((found[0].event as { comments: string }).comments).toContain("Still leaks.");
    });

    it("does not dispatch after our own push moved the head with no new review", async () => {
      const { bugs } = await standingTask();
      const { found, onFinding } = collect();
      // What a real tick sees right after `doPush`: a new head, a bumped updatedAt, the
      // review decision untouched because nobody has re-reviewed yet.
      const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", headSha: "def456", lastSeenEventAt: "2026-09-26T09:45:00Z" }) }], []);
      const w = new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms });
      await w.poll();
      expect(found[0].pr?.headSha).toBe("def456");   // still reported, for the card
      expect(found[0].event).toBeNull();             // but nothing dispatched
    });

    it("dispatches for a review with an empty body, falling back to a generic note", async () => {
      const { bugs } = await standingTask();
      const { found, onFinding } = collect();
      // A reviewer can request changes with no text at all. The evidence is the review event
      // itself, not the rendered text — so this must still dispatch.
      const forge = forgeWith([{ found: pr({ reviewDecision: "CHANGES_REQUESTED", lastSeenEventAt: "2026-09-26T10:00:00Z" }) }],
        [{ kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "   ", at: "2026-09-26T10:00:00Z" }]);
      await new PrWatcher({ bugs, forge, onFinding, now: () => 0, jitter: ms => ms }).poll();
      expect(found[0].event).toMatchObject({ type: "review-changes-requested" });
      expect((found[0].event as { comments: string }).comments).toMatch(/changes were requested/);
    });
  });
});
