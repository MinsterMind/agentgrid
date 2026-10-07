import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { fetchIssuesVia, type TrackerProvider } from "./tracker.js";
import type { BugFixEngine } from "./engine.js";
import type { GitOps } from "./git.js";
import type { ForgeAdapter } from "./forge/types.js";
import type { TrackerCache } from "./trackerCache.js";
import type { PrInfo, TrackerIssue } from "./types.js";
import type { GridEvent, ImportState } from "../types.js";

export type { ImportState };
const KEEP = 10;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The key as a whole word: PAY-41 is in "feature/PAY-41-x" and "pay-41: fix", never in "PAY-410" or "XPAY-41". */
export const matchesKey = (text: string, key: string) => new RegExp(`(^|[^A-Za-z0-9])${esc(key)}([^0-9]|$)`, "i").test(text);

interface Deps {
  engine: Pick<BugFixEngine, "importTask" | "intake">;
  git: Pick<GitOps, "fetch" | "remoteBranches" | "integrationBranch">;
  forge: Pick<ForgeAdapter, "listOpenPrs" | "findMergedPr"> | null;
  tracker: TrackerProvider; cache: TrackerCache | null;
  /** The id of a task already working on this ticket (not finished), if any. */
  activeTaskFor?: (key: string) => string | null;
}

/**
 * Picks up tickets already in progress (spec 2026-10-09 §3): per repo, one fetch and one listing of its open PRs; per key,
 * its open PR (by branch or title), else a pushed branch, else a merged PR, else a normal start. Several PRs for one key
 * wait for the user's choice. One import at a time per repo; progress is announced after each key.
 */
export class Importer extends EventEmitter {
  private states = new Map<string, ImportState>();
  private pending = new Map<string, Map<string, { repo: string; issue: TrackerIssue; prs: PrInfo[]; protect: string[] }>>();
  private repoLocks = new Map<string, Promise<void>>();
  constructor(private deps: Deps) { super(); }

  get(id: string): ImportState | null { return this.states.get(id) ?? null; }

  /** Start in the background; returns the import id at once. */
  start(all: string[], repo: string): string {
    const seen = new Set<string>();
    const keys = all.map(k => k.trim().toUpperCase()).filter(k => { if (!k || seen.has(k)) return false; seen.add(k); return true; });
    const importId = `i${randomBytes(4).toString("hex")}`;
    const st: ImportState = { importId, total: keys.length, done: 0, imported: [], choose: [], skipped: [], failed: [], finished: false };
    this.states.set(importId, st); this.pending.set(importId, new Map());
    while (this.states.size > KEEP) { const old = this.states.keys().next().value!; this.states.delete(old); this.pending.delete(old); }
    this.announce(st);
    void this.locked(repo, () => this.run(st, keys, repo)).catch(err => {
      const handled = new Set([...st.imported, ...st.choose, ...st.skipped, ...st.failed].map(x => x.key));
      for (const k of keys) if (!handled.has(k)) st.failed.push({ key: k, message: (err as Error).message });
      st.done = st.total;
    }).finally(() => { st.finished = true; this.announce(st); });
    return importId;
  }

  /** The user picked which of a key's open PRs is its fix. */
  async choose(id: string, key: string, prNumber: number): Promise<ImportState> {
    const st = this.states.get(id); const p = this.pending.get(id)?.get(key.toUpperCase());
    if (!st || !p) throw Object.assign(new Error(`nothing to choose for ${key} in import ${id}`), { status: 404 });
    const pr = p.prs.find(x => x.number === prNumber);
    if (!pr) throw Object.assign(new Error(`#${prNumber} isn't one of ${key}'s candidates`), { status: 400 });
    st.choose = st.choose.filter(c => c.key !== p.issue.key);
    this.pending.get(id)!.delete(key.toUpperCase());
    try { const t = await this.deps.engine.importTask({ issue: p.issue, repo: p.repo, found: { kind: "pr", pr }, protect: p.protect }); st.imported.push({ key: p.issue.key, taskId: t.id, stage: t.stage }); }
    catch (err) { st.failed.push({ key: p.issue.key, message: (err as Error).message }); }
    this.announce(st);
    return st;
  }

  private async run(st: ImportState, keys: string[], repo: string): Promise<void> {
    const end = (r: { imported?: ImportState["imported"][number]; skipped?: ImportState["skipped"][number]; failed?: ImportState["failed"][number] }) => {
      if (r.imported) st.imported.push(r.imported);
      if (r.skipped) st.skipped.push(r.skipped);
      if (r.failed) st.failed.push(r.failed);
      st.done++; this.announce(st);
    };
    try { await this.deps.git.fetch(repo); }
    catch (err) { for (const k of keys) end({ failed: { key: k, message: `could not fetch from origin: ${(err as Error).message}` } }); return; }
    const listed = this.deps.forge?.listOpenPrs ? await this.deps.forge.listOpenPrs(repo, { all: true }) : { unavailable: "this forge can't list pull requests" };
    const prs = "prs" in listed ? listed.prs.filter(p => p.state === "OPEN") : [];
    const prProblem = "unavailable" in listed ? listed.unavailable : null;
    const protect = [...new Set(("prs" in listed ? listed.prs : []).map(p => p.baseBranch).filter((b): b is string => !!b))];
    const base = await this.deps.git.integrationBranch(repo).catch(() => "");
    const branches = (await this.deps.git.remoteBranches(repo)).filter(b => b !== base && b !== "HEAD");
    const read = this.deps.cache ? await this.deps.cache.issues(keys) : await fetchIssuesVia(this.deps.tracker, keys);
    const byKey = new Map(read.issues.map(i => [i.key.toUpperCase(), i]));
    for (const key of keys) {
      const active = this.deps.activeTaskFor?.(key) ?? null;
      if (active) { end({ skipped: { key, message: `${key} is already in AgentGrid (${active})` } }); continue; }
      const issue = byKey.get(key);
      if (!issue) { end({ failed: { key, message: `couldn't read ${key} from the tracker: ${("errors" in read ? read.errors[key] : undefined) ?? "not in the tracker's answer"}` } }); continue; }
      try {
        const open = prs.filter(p => matchesKey(p.headBranch ?? "", key) || matchesKey(p.title ?? "", key));
        if (open.length > 1) {
          this.pending.get(st.importId)?.set(key, { repo, issue, prs: open, protect });
          st.choose.push({ key: issue.key, candidates: open.map(p => ({ number: p.number, title: p.title ?? "", branch: p.headBranch ?? "", url: p.url })) });
          st.done++; this.announce(st); continue;
        }
        const branch = open.length ? null : branches.find(b => matchesKey(b, key)) ?? null;
        const merged = open.length || branch ? null : await this.deps.forge?.findMergedPr?.(repo, key) ?? null;
        const found = open.length ? { kind: "pr" as const, pr: open[0] } : branch ? { kind: "branch" as const, branch } : merged ? { kind: "merged" as const, pr: merged } : null;
        const t = found ? await this.deps.engine.importTask({ issue, repo, found, protect }) : await this.deps.engine.intake({ issueRef: key, repo, issue, fetched: true });
        end({ imported: { key: issue.key, taskId: t.id, stage: t.stage } });
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.code === "already-on-base") { end({ skipped: { key, message: e.message } }); continue; }
        end({ failed: { key, message: prProblem ? `${e.message} (open pull requests couldn't be listed: ${prProblem})` : e.message } });
      }
    }
  }

  /** One import at a time per repo: two would race on fetches and worktrees. */
  private async locked(repo: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.repoLocks.get(repo) ?? Promise.resolve();
    const run = prev.then(fn, fn); const tail = run.catch(() => {});
    this.repoLocks.set(repo, tail);
    try { await run; } finally { if (this.repoLocks.get(repo) === tail) this.repoLocks.delete(repo); }
  }

  private announce(st: ImportState): void {
    this.emit("event", { type: "import", state: { ...st, imported: [...st.imported], choose: [...st.choose], skipped: [...st.skipped], failed: [...st.failed] } } satisfies GridEvent);
  }
}
