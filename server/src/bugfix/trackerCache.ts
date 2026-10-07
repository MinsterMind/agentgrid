import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { writeAtomic } from "../store/store.js";
import { fetchIssuesVia, type TrackerProvider } from "./tracker.js";
import type { IssueSummary, TrackerIssue } from "./types.js";
import type { GridEvent, IssueList } from "../types.js";

interface Entry { issue: TrackerIssue; fetchedAt: number }
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

  constructor(private deps: { tracker: TrackerProvider; file: string; now?: () => number; listTtlMs?: number; issueTtlMs?: number; writeEveryMs?: number }) {
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
      if (Array.isArray(d?.list?.issues)) { this.list = d.list.issues; this.listAt = d.list.fetchedAt ? Date.parse(d.list.fetchedAt) : null; }
      for (const [k, v] of Object.entries(d?.issues ?? {}) as Array<[string, { issue: TrackerIssue; fetchedAt: string }]>) {
        if (v?.issue?.key) this.entries.set(k, { issue: v.issue, fetchedAt: Date.parse(v.fetchedAt) || 0 });
      }
    } catch { /* a corrupt cache is just an empty one */ }
  }

  private state(): IssueList {
    return { issues: this.list, fetchedAt: this.listAt === null ? null : new Date(this.listAt).toISOString(), refreshing: this.listing !== null, error: this.listError };
  }

  /** The list now; refreshed in the background when stale or never fetched. */
  myIssues(): IssueList {
    if (this.listAt === null || this.now() - this.listAt > this.listTtl) void this.refresh().catch(() => {});
    return this.state();
  }

  /** Re-read the list (one call at a time); a failure keeps the last list and says why. */
  refresh(): Promise<IssueList> {
    if (this.listing) return this.listing;
    this.listing = (async () => {
      try {
        this.list = await this.deps.tracker.listMyIssues();
        this.listAt = this.now(); this.listError = null;
        void this.prefetch();
      } catch (err) {
        this.listError = (err as Error).message;
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
  private put(issue: TrackerIssue): void {
    this.entries.set(issue.key, { issue, fetchedAt: this.now() });
    this.changed({ type: "tracker-issue", issue });
  }

  /** One ticket: from the cache while fresh, else one fetch (shared by concurrent callers). */
  issue(key: string): Promise<TrackerIssue> {
    const hit = this.fresh(key);
    if (hit) return Promise.resolve(hit);
    const inFlight = this.fetching.get(key);
    if (inFlight) return inFlight;
    const p = this.deps.tracker.fetchIssue(key).then(i => { this.put(i); return i; }).finally(() => this.fetching.delete(key));
    this.fetching.set(key, p);
    return p;
  }

  /** Many tickets: fresh ones from the cache, the rest read 20 per tracker call. Never throws. */
  async issues(keys: string[]): Promise<{ issues: TrackerIssue[]; missing: string[] }> {
    const need = keys.filter(k => !this.fresh(k));
    const missing: string[] = [];
    for (let i = 0; i < need.length; i += BATCH) {
      const r = await fetchIssuesVia(this.deps.tracker, need.slice(i, i + BATCH));
      for (const issue of r.issues) this.put(issue);
      missing.push(...r.missing);
    }
    return { issues: keys.filter(k => !missing.includes(k) && this.entries.has(k)).map(k => this.entries.get(k)!.issue), missing };
  }

  /** After a list refresh: fetch listed tickets not fresh in the cache, a batch at a time. */
  private prefetch(): Promise<void> {
    if (this.prefetching) return this.prefetching;
    this.prefetching = this.issues(this.list.map(i => i.key)).then(() => {}, () => {}).finally(() => { this.prefetching = null; });
    return this.prefetching;
  }

  invalidate(key: string): void { this.entries.delete(key); }
  /** Forget everything — the tracker configuration changed. */
  clear(): void {
    this.list = []; this.listAt = null; this.listError = null; this.entries.clear();
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
    await writeAtomic(this.deps.file, { list: { issues: this.list, fetchedAt: this.state().fetchedAt }, issues });
  }
}
