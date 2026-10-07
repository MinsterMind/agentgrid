import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { fetchIssuesVia, type TrackerProvider } from "./tracker.js";
import type { BugFixEngine } from "./engine.js";
import type { GitOps } from "./git.js";
import type { TrackerCache } from "./trackerCache.js";
import type { BatchState, GridEvent } from "../types.js";

export type { BatchState };
export interface BatchItem { issueRef: string; repo: string; baseBranch?: string }
const KEEP = 10;
const keyOf = (ref: string) => (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(ref) ? ref : ref.split(/[/?#]/).filter(Boolean).pop() ?? ref);

/**
 * Starts fixes for many tickets at once (spec 2026-10-08 §5.2). Each repo is fetched once and its
 * tickets read from the tracker 20 at a time, then each is started with what was already read and
 * fetched. A ticket that can't start — may already be fixed, unreadable, a leftover worktree — is its
 * own result; the others go on. One batch at a time per repo. Progress is announced after each ticket.
 */
export class BatchStarter extends EventEmitter {
  private states = new Map<string, BatchState>();
  private repoLocks = new Map<string, Promise<void>>();
  constructor(private deps: { engine: Pick<BugFixEngine, "intake">; git: Pick<GitOps, "fetch">; tracker: TrackerProvider; cache: TrackerCache | null }) { super(); }

  get(id: string): BatchState | null { return this.states.get(id) ?? null; }

  /** Start in the background; returns the batch id at once. */
  start(items: BatchItem[], startAnyway: string[]): string {
    const batchId = `b${randomBytes(4).toString("hex")}`;
    const state: BatchState = { batchId, total: items.length, done: 0, started: [], skipped: [], failed: [], finished: false };
    this.states.set(batchId, state);
    while (this.states.size > KEEP) this.states.delete(this.states.keys().next().value!);
    this.announce(state);
    void this.run(state, items, new Set(startAnyway.map(k => k.toUpperCase()))).catch(err => {
      for (const it of items.slice(state.done)) state.failed.push({ key: keyOf(it.issueRef), message: (err as Error).message });
      state.done = state.total; state.finished = true; this.announce(state);
    });
    return batchId;
  }

  private async run(state: BatchState, items: BatchItem[], anyway: Set<string>): Promise<void> {
    const byRepo = new Map<string, BatchItem[]>();
    for (const it of items) byRepo.set(it.repo, [...(byRepo.get(it.repo) ?? []), it]);
    for (const [repo, its] of byRepo) await this.locked(repo, () => this.runRepo(state, repo, its, anyway));
    state.finished = true;
    this.announce(state);
  }

  private async runRepo(state: BatchState, repo: string, items: BatchItem[], anyway: Set<string>): Promise<void> {
    const finish = (key: string, r: { started?: string; skipped?: string; failed?: string }) => {
      if (r.started) state.started.push({ key, taskId: r.started });
      if (r.skipped) state.skipped.push({ key, message: r.skipped });
      if (r.failed) state.failed.push({ key, message: r.failed });
      state.done++; this.announce(state);
    };
    try { await this.deps.git.fetch(repo); }
    catch (err) { for (const it of items) finish(keyOf(it.issueRef), { failed: `could not fetch from origin: ${(err as Error).message}` }); return; }
    const keys = items.map(it => keyOf(it.issueRef));
    const read = this.deps.cache ? await this.deps.cache.issues(keys) : await fetchIssuesVia(this.deps.tracker, keys);
    const byKey = new Map(read.issues.map(i => [i.key.toUpperCase(), i]));
    for (const it of items) {
      const key = keyOf(it.issueRef);
      const issue = byKey.get(key.toUpperCase());
      if (!issue) { finish(key, { failed: `couldn't read ${key} from the tracker` }); continue; }
      try {
        const t = await this.deps.engine.intake({ issueRef: it.issueRef, repo, ...(it.baseBranch ? { baseBranch: it.baseBranch } : {}),
          issue, fetched: true, ...(anyway.has(key.toUpperCase()) ? { startAnyway: true } : {}) });
        finish(key, { started: t.id });
      } catch (err) {
        const e = err as Error & { code?: string };
        finish(key, e.code === "already-on-base" ? { skipped: e.message } : { failed: e.message });
      }
    }
  }

  /** One batch at a time per repo: two would race on fetches and worktrees. */
  private async locked(repo: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.repoLocks.get(repo) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.repoLocks.set(repo, tail);
    try { await run; } finally { if (this.repoLocks.get(repo) === tail) this.repoLocks.delete(repo); }
  }

  private announce(state: BatchState): void {
    this.emit("event", { type: "batch", state: { ...state, started: [...state.started], skipped: [...state.skipped], failed: [...state.failed] } } satisfies GridEvent);
  }
}
