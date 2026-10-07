import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrackerCache } from "../../src/bugfix/trackerCache.js";
import type { TrackerProvider } from "../../src/bugfix/tracker.js";
import type { IssueSummary, TrackerIssue } from "../../src/bugfix/types.js";

const summary = (n: number): IssueSummary => ({ key: `PAY-${n}`, title: `t${n}`, url: "u", status: "Open", priority: "High" });
const full = (key: string): TrackerIssue => ({ key, title: key, url: "u", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] });
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(r => setTimeout(r, 0));

let calls: { list: number; fetch: string[]; batch: string[][] }; let list: IssueSummary[]; let listGate: ReturnType<typeof deferred<void>> | null; let listFail: Error | null;
let t = 0; let file: string;
const tracker: TrackerProvider = {
  listMyIssues: async () => { calls.list++; if (listGate) await listGate.promise; if (listFail) throw listFail; return list; },
  fetchIssue: async (k: string) => { calls.fetch.push(k); await tick(); return full(k); },
  fetchIssues: async (keys: string[]) => { calls.batch.push(keys); await tick(); return { issues: keys.map(full), missing: [] }; },
  comment: async () => {},
};
const cache = () => new TrackerCache({ tracker, file, now: () => t, writeEveryMs: 0 });
beforeEach(async () => {
  calls = { list: 0, fetch: [], batch: [] }; list = [summary(1), summary(2)]; listGate = null; listFail = null; t = 0;
  file = path.join(await mkdtemp(path.join(tmpdir(), "tc-")), "tracker-cache.json");
});
const settle = async (c: TrackerCache) => { for (let i = 0; i < 20; i++) await tick(); await c.flush(); };

describe("TrackerCache — the list", () => {
  it("answers at once, refreshing behind the scenes once; stale after 2 minutes", async () => {
    const c = cache();
    listGate = deferred();
    expect(c.myIssues()).toMatchObject({ issues: [], refreshing: true, fetchedAt: null });
    c.myIssues();
    expect(calls.list).toBe(1);
    listGate.resolve(); listGate = null; await settle(c);
    expect(c.myIssues()).toMatchObject({ issues: list, refreshing: false });
    expect(calls.list).toBe(1);
    t = 2 * 60_000 + 1;
    expect(c.myIssues().issues).toEqual(list);              // the old list, at once
    expect(calls.list).toBe(2);
  });
  // Review Focus 1
  it("two refreshes at once cost one tracker call", async () => {
    const c = cache();
    listGate = deferred();
    const a = c.refresh(), b = c.refresh();
    listGate.resolve();
    await Promise.all([a, b]);
    expect(calls.list).toBe(1);
  });
  it("a failed refresh keeps the list and says why; the next success clears it", async () => {
    const c = cache();
    await c.refresh();
    listFail = new Error("tracker unavailable");
    expect(await c.refresh()).toMatchObject({ issues: list, error: "tracker unavailable" });
    listFail = null;
    expect((await c.refresh()).error).toBeNull();
  });
});

describe("TrackerCache — tickets", () => {
  it("keeps a ticket 15 minutes; one fetch per key in flight; invalidate forces a fetch", async () => {
    const c = cache();
    await Promise.all([c.issue("PAY-9"), c.issue("PAY-9")]);
    expect(calls.fetch).toEqual(["PAY-9"]);
    await c.issue("PAY-9"); expect(calls.fetch).toEqual(["PAY-9"]);
    t = 15 * 60_000 + 1; await c.issue("PAY-9"); expect(calls.fetch).toEqual(["PAY-9", "PAY-9"]);
    c.invalidate("PAY-9"); await c.issue("PAY-9"); expect(calls.fetch).toHaveLength(3);
  });
  it("prefetches listed tickets 20 at a time, one batch at a time, skipping fresh ones", async () => {
    list = Array.from({ length: 45 }, (_, i) => summary(i + 1));
    const c = cache();
    await c.issue("PAY-1");
    await c.refresh(); await settle(c);
    expect(calls.batch.map(b => b.length)).toEqual([20, 20, 4]);       // PAY-1 was fresh
    expect(calls.batch.flat()).not.toContain("PAY-1");
  });
  it("issues(keys) reads what it lacks in batches of 20 and answers the rest from the cache", async () => {
    const c = cache();
    await c.issue("PAY-1");
    const keys = Array.from({ length: 25 }, (_, i) => `PAY-${i + 1}`);
    const r = await c.issues(keys);
    expect(r.issues.map(i => i.key)).toEqual(keys); expect(r.missing).toEqual([]);
    expect(calls.batch.map(b => b.length)).toEqual([20, 4]);
  });
});

describe("TrackerCache — disk and events", () => {
  it("survives a restart: the list and tickets answer at once", async () => {
    const c = cache();
    await c.refresh(); await c.issue("PAY-7"); await c.flush();
    const c2 = cache(); await c2.load();
    expect(c2.myIssues()).toMatchObject({ issues: list, fetchedAt: new Date(0).toISOString() });
    await c2.issue("PAY-7");
    expect(calls.fetch.filter(k => k === "PAY-7")).toHaveLength(1);
  });
  it("a corrupt file means an empty cache, never an error", async () => {
    await writeFile(file, "{nope");
    const c = cache(); await c.load();
    expect(c.myIssues().issues).toEqual([]);
  });
  it("announces a new list and each fetched ticket; clear forgets everything", async () => {
    const c = cache(); const events: string[] = [];
    c.on("event", e => events.push(e.type));
    await c.refresh(); await c.issue("PAY-3");
    expect(events).toContain("tracker-issues"); expect(events).toContain("tracker-issue");
    c.clear();
    expect(c.myIssues()).toMatchObject({ issues: [], fetchedAt: null });
  });
});

describe("TrackerCache — reads in flight (final review #8)", () => {
  it("opening a ticket that prefetch is reading joins that read — one tracker call", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const slow: TrackerProvider = { ...tracker, fetchIssues: async (keys: string[]) => { calls.batch.push(keys); await gate; return { issues: keys.map(full), missing: [] }; } };
    const c = new TrackerCache({ tracker: slow, file, now: () => t, writeEveryMs: 0 });
    const batch = c.issues(["PAY-1", "PAY-2"]);
    const one = c.issue("PAY-1");
    release(); await Promise.all([batch, one]);
    expect(calls.fetch).toEqual([]); expect(calls.batch).toEqual([["PAY-1", "PAY-2"]]);
  });
  it("an older answer never replaces a newer one", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const slow: TrackerProvider = { ...tracker,
      fetchIssues: async (keys: string[]) => { await gate; return { issues: keys.map(k => ({ ...full(k), title: "old" })), missing: [] }; },
      fetchIssue: async (k: string) => ({ ...full(k), title: "new" }) };
    const c = new TrackerCache({ tracker: slow, file, now: () => t, writeEveryMs: 0 });
    const batch = c.issues(["PAY-1"]);                  // started first, answers last
    t = 1000; c.invalidate("PAY-1");                    // e.g. the ticket was just started
    expect((await c.issue("PAY-1")).title).toBe("new");
    release(); await batch;
    expect((await c.issue("PAY-1")).title).toBe("new");
  });
});

describe("TrackerCache — a different tracker (final review #2, Review Focus 4)", () => {
  it("a cache file written for another tracker is not loaded", async () => {
    const a = new TrackerCache({ tracker, file, now: () => t, writeEveryMs: 0, identity: "jira|mcp__old" });
    await a.refresh(); await a.flush();
    const b = new TrackerCache({ tracker, file, now: () => t, writeEveryMs: 0, identity: "jira|mcp__new" }); await b.load();
    expect(b.myIssues().issues).toEqual([]);
    const same = new TrackerCache({ tracker, file, now: () => t, writeEveryMs: 0, identity: "jira|mcp__old" }); await same.load();
    expect(same.myIssues().issues).toEqual(list);
  });
  it("a read that began before a clear doesn't bring the old list back", async () => {
    const c = cache();
    listGate = deferred();
    const r = c.refresh();
    c.clear();
    listGate.resolve(); await r;
    expect(c.myIssues()).toMatchObject({ fetchedAt: null });
    expect(c.myIssues().generation).toBeGreaterThan(0);
  });
});
