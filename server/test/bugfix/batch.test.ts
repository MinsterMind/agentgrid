import { describe, it, expect, beforeEach } from "vitest";
import { BatchStarter, type BatchState } from "../../src/bugfix/batch.js";
import { Conflict } from "../../src/store/store.js";
import type { TrackerProvider } from "../../src/bugfix/tracker.js";
import type { TrackerIssue } from "../../src/bugfix/types.js";

const full = (key: string): TrackerIssue => ({ key, title: key, url: "u", status: "Open", priority: "High", description: "", acceptanceCriteria: [] });
let fetched: string[]; let reads: string[][]; let intakes: Array<{ issueRef: string; repo: string; baseBranch?: string; startAnyway?: boolean; fetched?: boolean; issue?: TrackerIssue }>;
let fetchGate: Promise<void> | null; let failFetch: Set<string>; let missing: Set<string>; let leftovers: Set<string>; let onBase: Set<string>; let events: BatchState[];
const tracker = (): TrackerProvider => ({ listMyIssues: async () => [], fetchIssue: async k => full(k), comment: async () => {},
  fetchIssues: async keys => { reads.push(keys); return { issues: keys.filter(k => !missing.has(k)).map(full), missing: keys.filter(k => missing.has(k)) }; } });
const engine = () => ({ intake: async (i: (typeof intakes)[number]) => {
  intakes.push(i);
  const key = i.issueRef;
  if (leftovers.has(key)) throw new Conflict(`a worktree and/or branch for ${key} already exist from an earlier run — … To clear it and try again, run:\n  git -C /r branch -D bugfix/${key}`);
  if (onBase.has(key) && !i.startAnyway) throw Object.assign(new Conflict(`${key} may already be fixed: origin/main has a commit naming it —\n  abc123 ${key}: fix`), { code: "already-on-base" });
  return { id: `bt-${key}` };
} });
const git = () => ({ fetch: async (repo: string) => { fetched.push(repo); if (fetchGate) await fetchGate; if (failFetch.has(repo)) throw new Error("could not resolve host"); } });
let active: Record<string, string>;
const starter = () => { const s = new BatchStarter({ engine: engine() as never, git: git() as never, tracker: tracker(), cache: null, activeTaskFor: k => active[k] ?? null }); s.on("event", e => events.push(e.state)); return s; };
const finished = async (s: BatchStarter, id: string) => { for (let i = 0; i < 200 && !s.get(id)?.finished; i++) await new Promise(r => setTimeout(r, 5)); return s.get(id)!; };
beforeEach(() => { fetched = []; reads = []; intakes = []; fetchGate = null; failFetch = new Set(); missing = new Set(); leftovers = new Set(); onBase = new Set(); events = []; active = {}; });

describe("BatchStarter", () => {
  // Review Focus 2
  it("one fetch per repo, one tracker read for the repo's tickets; a repo that can't fetch fails only its own", async () => {
    failFetch.add("/r/broken");
    const s = starter();
    const id = s.start([{ issueRef: "PAY-1", repo: "/r/pay" }, { issueRef: "PAY-2", repo: "/r/pay", baseBranch: "develop" }, { issueRef: "PAY-3", repo: "/r/pay" }, { issueRef: "OPS-1", repo: "/r/broken" }], []);
    const st = await finished(s, id);
    expect(fetched.sort()).toEqual(["/r/broken", "/r/pay"]);
    expect(reads).toEqual([["PAY-1", "PAY-2", "PAY-3"]]);
    expect(st.started.map(x => x.key)).toEqual(["PAY-1", "PAY-2", "PAY-3"]);
    expect(st.failed).toEqual([{ key: "OPS-1", message: "could not fetch from origin: could not resolve host" }]);
    expect(intakes.every(i => i.fetched === true && i.issue)).toBe(true);
    expect(intakes[1]).toMatchObject({ baseBranch: "develop" });
  });
  it("a ticket the tracker didn't return fails on its own", async () => {
    missing.add("PAY-2");
    const s = starter(); const st = await finished(s, s.start([{ issueRef: "PAY-1", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }], []));
    expect(st.started.map(x => x.key)).toEqual(["PAY-1"]);
    expect(st.failed).toEqual([{ key: "PAY-2", message: "couldn't read PAY-2 from the tracker: not in the tracker's answer" }]);
  });
  it("may-already-be-fixed is skipped with its commits; start-anyway starts it", async () => {
    onBase.add("PAY-1");
    const s = starter();
    const st = await finished(s, s.start([{ issueRef: "PAY-1", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }], []));
    expect(st.skipped).toEqual([{ key: "PAY-1", message: expect.stringContaining("abc123 PAY-1: fix") }]);
    const st2 = await finished(s, s.start([{ issueRef: "PAY-1", repo: "/r" }], ["PAY-1"]));
    expect(st2.started.map(x => x.key)).toEqual(["PAY-1"]);
  });
  // Review Focus 5
  it("a leftover worktree is that ticket's failure, with how to clear it; the rest start", async () => {
    leftovers.add("PAY-2");
    const s = starter(); const st = await finished(s, s.start([{ issueRef: "PAY-1", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }, { issueRef: "PAY-3", repo: "/r" }], []));
    expect(st.started.map(x => x.key)).toEqual(["PAY-1", "PAY-3"]);
    expect(st.failed[0]).toMatchObject({ key: "PAY-2", message: expect.stringContaining("To clear it and try again") });
  });
  it("reports progress after each ticket, and keeps the last ten", async () => {
    const s = starter(); const id = s.start([{ issueRef: "PAY-1", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }], []);
    await finished(s, id);
    expect(events.map(e => e.done)).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(events.at(-1)).toMatchObject({ batchId: id, total: 2, done: 2, finished: true });
    const ids = Array.from({ length: 11 }, () => s.start([{ issueRef: "PAY-9", repo: "/r" }], []));
    await finished(s, ids.at(-1)!);
    expect(s.get(id)).toBeNull(); expect(s.get(ids.at(-1)!)).not.toBeNull();
  });
  it("one batch at a time per repo: the second waits for the first's tickets", async () => {
    let release!: () => void; fetchGate = new Promise(r => { release = r; });
    const s = starter();
    const a = s.start([{ issueRef: "PAY-1", repo: "/r" }], []);
    const b = s.start([{ issueRef: "PAY-2", repo: "/r" }], []);
    await new Promise(r => setTimeout(r, 20));
    expect(fetched).toEqual(["/r"]);                          // b hasn't fetched yet
    fetchGate = null; release();
    await finished(s, a); await finished(s, b);
    expect(fetched).toEqual(["/r", "/r"]);
    expect(intakes.map(i => i.issueRef)).toEqual(["PAY-1", "PAY-2"]);
  });

  it("a ticket URL with a query string starts by its key; a read that fails says why", async () => {
    missing.add("PAY-2");
    const s = starter(); const st = await finished(s, s.start([{ issueRef: "https://jira/browse/PAY-1?focusedCommentId=99#c", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }], []));
    expect(st.started.map(x => x.key)).toEqual(["PAY-1"]);
    expect(st.failed[0]).toEqual({ key: "PAY-2", message: "couldn't read PAY-2 from the tracker: not in the tracker's answer" });
  });

  // Final review #5: the leftover-worktree advice told the user to force-remove a live fix's worktree.
  it("a ticket already being fixed is said so plainly; a ticket listed twice is started once", async () => {
    active["PAY-1"] = "bt12";
    const s = starter();
    const st = await finished(s, s.start([{ issueRef: "PAY-1", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }, { issueRef: "PAY-2", repo: "/r" }], []));
    expect(st.total).toBe(2);
    expect(st.failed).toEqual([{ key: "PAY-1", message: "PAY-1 is already being fixed (bt12)" }]);
    expect(st.started.map(x => x.key)).toEqual(["PAY-2"]);
    expect(intakes.map(i => i.issueRef)).toEqual(["PAY-2"]);
  });
});
