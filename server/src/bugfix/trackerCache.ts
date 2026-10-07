import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { writeAtomic } from "../store/store.js";
import { fetchIssuesVia, type TrackerProvider } from "./tracker.js";
import type { IssueSummary, TrackerIssue } from "./types.js";
import type { GridEvent, IssueList } from "../types.js";

/** `requestedAt`: when the read that produced it began — an older read's answer never replaces a newer one. */
interface Entry { issue: TrackerIssue; fetchedAt: number; requestedAt: number }
const BATCH = 20;

/**
 * Tracker reads are model runs through the user's MCP — seconds each. This answers from memory (and,
 * after a restart, from disk) at once, and refreshes behind the scenes: the list when it is over
 * 2 minutes old, a ticket when over 15. Listed tickets are prefetched 20 at a time, so opening one is
 * instant. Concurrent requests for the same thing share one tracker call (spec 2026-10-08 §3.3).
 */
export class TrackerCache extends EventEmitter {
  private list: IssueSummary[] = [];
  private listAt: number | null = null;
  private listError: string | null = null;
  private listing: Promise<IssueList> | null = null;
  private entries = new Map<string, Entry>();
  private fetching = new Map<string, Promise<TrackerIssue>>();
  private prefetching: Promise<void> | null = null;
  private writeTimer: NodeJS.Timeout | null = null;
  private now: () => number;

  /** Bumped by clear(): an answer to a read begun before it belongs to the old tracker and is dropped. */
  private generation = 0;
  /** `identity`: which tracker this cache is for (preset, tool prefix, hints) — a file written for another is not loaded. */
  constructor(private deps: { tracker: TrackerProvider; file: string; identity?: string; now?: () => number; listTtlMs?: number; issueTtlMs?: number; writeEveryMs?: number }) {
    super();
    this.now = deps.now ?? (() => Date.now());
  }
  private get listTtl() { return this.deps.listTtlMs ?? 2 * 60_000; }
  private get issueTtl() { return this.deps.issueTtlMs ?? 15 * 60_000; }

  async load(): Promise<void> {
    const raw = await readFile(this.deps.file, "utf8").catch(() => null);
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if ((d?.identity ?? "") !== (this.deps.identity ?? "")) return;   // another tracker's bugs: never show them
      if (Array.isArray(d?.list?.issues)) { this.list = d.list.issues; this.listAt = d.list.fetchedAt ? Date.parse(d.list.fetchedAt) : null; }
      for (const [k, v] of Object.entries(d?.issues ?? {}) as Array<[string, { issue: TrackerIssue; fetchedAt: string }]>) {
        if (v?.issue?.key) { const at = Date.parse(v.fetchedAt) || 0; this.entries.set(k, { issue: v.issue, fetchedAt: at, requestedAt: at }); }
      }
    } catch { /* a corrupt cache is just an empty one */ }
  }

  private state(): IssueList {
    return { issues: this.list, fetchedAt: this.listAt === null ? null : new Date(this.listAt).toISOString(), refreshing: this.listing !== null, error: this.listError, generation: this.generation };
  }

  /** The list now; refreshed in the background when stale or never fetched. */
  myIssues(): IssueList {
    if (this.listAt === null || this.now() - this.listAt > this.listTtl) void this.refresh().catch(() => {});
    return this.state();
  }

  /** Re-read the list (one call at a time); a failure keeps the last list and says why. */
  refresh(): Promise<IssueList> {
    if (this.listing) return this.listing;
    const gen = this.generation;
    this.listing = (async () => {
      try {
        const list = await this.deps.tracker.listMyIssues();
        if (gen === this.generation) { this.list = list; this.listAt = this.now(); this.listError = null; void this.prefetch(); }
      } catch (err) {
        if (gen === this.generation) this.listError = (err as Error).message;
      } finally {
        this.listing = null;
      }
      this.changed({ type: "tracker-issues", list: this.state() });
      return this.state();
    })();
    this.changed({ type: "tracker-issues", list: this.state() });
    return this.listing;
  }

  private fresh(key: string): TrackerIssue | null {
    const e = this.entries.get(key);
    return e && this.now() - e.fetchedAt <= this.issueTtl ? e.issue : null;
  }
  private put(issue: TrackerIssue, requestedAt: number, gen = this.generation): void {
    if (gen !== this.generation) return;                    // read for the tracker before a clear
    const cur = this.entries.get(issue.key);
    if (cur && cur.requestedAt > requestedAt) return;      // a newer read already answered
    this.entries.set(issue.key, { issue, fetchedAt: this.now(), requestedAt });
    this.changed({ type: "tracker-issue", issue });
  }
  /** Register a read in flight for `key`, so other callers join it; it forgets itself when done. */
  private track(key: string, p: Promise<TrackerIssue>): Promise<TrackerIssue> {
    const tracked = p.finally(() => { if (this.fetching.get(key) === tracked) this.fetching.delete(key); });
    tracked.catch(() => {});
    this.fetching.set(key, tracked);
    return tracked;
  }

  /** One ticket: from the cache while fresh, else one fetch — shared with any read of it already in flight. */
  issue(key: string): Promise<TrackerIssue> {
    const hit = this.fresh(key);
    if (hit) return Promise.resolve(hit);
    const inFlight = this.fetching.get(key);
    if (inFlight) return inFlight;
    const at = this.now(); const gen = this.generation;
    return this.track(key, this.deps.tracker.fetchIssue(key).then(i => { this.put(i, at, gen); return this.entries.get(key)?.issue ?? i; }));
  }

  /** Many tickets: fresh ones from the cache, ones already being read joined, the rest read 20 per tracker call. Never throws. */
  async issues(keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[]; errors: Record<string, string> }> {
    const missing: string[] = []; const errors: Record<string, string> = {};
    const joined = keys.filter(k => !this.fresh(k) && this.fetching.has(k));
    const need = keys.filter(k => !this.fresh(k) && !this.fetching.has(k));
    for (let i = 0; i < need.length; i += BATCH) {
      const chunk = need.slice(i, i + BATCH); const at = this.now(); const gen = this.generation;
      const read = fetchIssuesVia(this.deps.tracker, chunk);
      for (const k of chunk) this.track(k, read.then(r => {
        const issue = r.issues.find(x => x.key.toUpperCase() === k.toUpperCase());
        if (!issue) throw new Error(r.errors[k] ?? "not in the tracker's answer");
        this.put(issue, at, gen); return this.entries.get(issue.key)?.issue ?? issue;
      }));
      const r = await read;
      for (const issue of r.issues) this.put(issue, at, gen);
      missing.push(...r.missing); Object.assign(errors, r.errors);
    }
    for (const k of joined) await this.fetching.get(k)?.catch((e: Error) => { missing.push(k); errors[k] = e.message; });
    return { issues: keys.filter(k => !missing.includes(k) && this.entries.has(k)).map(k => this.entries.get(k)!.issue), missing, errors };
  }

  /** After a list refresh: fetch listed tickets not fresh in the cache, a batch at a time. */
  private prefetch(): Promise<void> {
    if (this.prefetching) return this.prefetching;
    this.prefetching = this.issues(this.list.map(i => i.key)).then(() => {}, () => {}).finally(() => { this.prefetching = null; });
    return this.prefetching;
  }

  /** Forget a ticket, and any read of it already in flight — the next read starts fresh. */
  invalidate(key: string): void { this.entries.delete(key); this.fetching.delete(key); }
  /** Forget everything — the tracker configuration changed. */
  clear(): void {
    this.generation++;
    this.list = []; this.listAt = null; this.listError = null; this.entries.clear(); this.fetching.clear();
    this.changed({ type: "tracker-issues", list: this.state() });
  }

  private changed(e: GridEvent): void {
    this.emit("event", e);
    const every = this.deps.writeEveryMs ?? 5_000;
    if (!this.writeTimer) { this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.flush().catch(() => {}); }, every); this.writeTimer.unref?.(); }
  }

  async flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const issues = Object.fromEntries([...this.entries].map(([k, v]) => [k, { issue: v.issue, fetchedAt: new Date(v.fetchedAt).toISOString() }]));
    await writeAtomic(this.deps.file, { identity: this.deps.identity ?? "", list: { issues: this.list, fetchedAt: this.state().fetchedAt }, issues });
  }
}
