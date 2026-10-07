import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrackerSync, type StatusMap } from "../../src/bugfix/trackerSync.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import type { TrackerProvider, TransitionResult } from "../../src/bugfix/tracker.js";

let bugs: BugTaskStore; let id: string; let moves: string[]; let reply: (name: string) => Promise<TransitionResult>; let status: string; let map: StatusMap;
const tracker = (): TrackerProvider => ({
  listMyIssues: async () => [], comment: async () => {},
  fetchIssue: async (k: string) => ({ key: k, title: "", url: "", status, priority: "", description: "", acceptanceCriteria: [] }),
  transition: async (_k: string, name: string) => { moves.push(name); return reply(name); },
});
beforeEach(async () => {
  bugs = new BugTaskStore(await mkdtemp(path.join(tmpdir(), "ts-"))); await bugs.init();
  const t = await bugs.create({ issue: { key: "PAY-42", title: "t", url: "u", status: "Open", priority: "High", description: "", acceptanceCriteria: [] }, trackerProject: "PAY",
    sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", baseRef: "origin/main", ticketCommits: [], agentId: "a", mergePolicy: "ask", mergeMethod: "squash" });
  id = t.id; moves = []; status = "Open";
  reply = async () => ({ ok: true, status: "In Progress" });
  map = { PAY: { started: { transition: "Start Progress", to: "In Progress" }, prOpened: { transition: "Submit for Review", to: "In Review" }, merged: { transition: "Done", to: "Done" } } };
});
const sync = (t = tracker()) => new TrackerSync({ tracker: t, bugs, statusMap: async () => map, retryMs: 0 });
const notes = () => bugs.get(id).history.map(h => h.note);

describe("TrackerSync", () => {
  it("an unmapped moment does nothing; a mapped one moves the ticket and says so", async () => {
    const s = sync();
    s.moment(id, "noChange"); await s.idle();
    expect(moves).toEqual([]);
    s.moment(id, "started"); await s.idle();
    expect(moves).toEqual(["Start Progress"]);
    expect(notes()).toContain("Moved PAY-42 to In Progress");
  });
  it("a failure is retried once, then recorded; a later success clears it", async () => {
    reply = async () => ({ ok: false, error: "workflow says no" });
    const s = sync();
    s.moment(id, "started"); await s.idle();
    expect(moves).toEqual(["Start Progress", "Start Progress"]);
    expect(notes()).toContain("Couldn't move PAY-42 to In Progress: workflow says no");
    expect(bugs.get(id).trackerSyncError).toBe("Couldn't move PAY-42 to In Progress: workflow says no");
    reply = async () => ({ ok: true, status: "In Review" });
    s.moment(id, "prOpened"); await s.idle();
    expect(bugs.get(id).trackerSyncError).toBeNull();
  });
  it("a ticket already in the target status is a no-op, not a failure", async () => {
    reply = async () => ({ ok: false, error: "transition not available" });
    status = "in progress";
    const s = sync();
    s.moment(id, "started"); await s.idle();
    expect(moves).toEqual(["Start Progress"]);
    expect(notes()).toContain("PAY-42 is already In Progress");
    expect(bugs.get(id).trackerSyncError).toBeNull();
  });
  // Review Focus 3
  it("moves happen in moment order, even when one is slow", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    reply = async name => { if (name === "Submit for Review") await gate; return { ok: true, status: name }; };
    const s = sync();
    s.moment(id, "prOpened"); s.moment(id, "merged");
    await new Promise(r => setTimeout(r, 10));
    expect(moves).toEqual(["Submit for Review"]);
    release(); await s.idle();
    expect(moves).toEqual(["Submit for Review", "Done"]);
  });
  it("a tracker that can't move tickets, or a task that's gone, is a quiet no-op", async () => {
    const t = tracker(); delete (t as Partial<TrackerProvider>).transition;
    const s = sync(t); s.moment(id, "started"); await s.idle();
    const s2 = sync(); s2.moment("bt999", "started"); await s2.idle();
    expect(moves).toEqual([]);
  });
});
