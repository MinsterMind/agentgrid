import { WATCHED_STAGES, type BugEvent, type BugTask, type PrInfo } from "./types.js";
import type { BugTaskStore } from "./store.js";
import type { ForgeAdapter, ReviewEvent } from "./forge/types.js";

export interface PrFinding {
  taskId: string;
  /** Latest view, for the card. Null only when the PR itself is gone (`lookup.found === null`);
   *  an unreadable forge instead keeps and reports the last known view — no information is
   *  never allowed to read as "the PR vanished". */
  pr: PrInfo | null;
  event: BugEvent | null;            // the transition to apply, if any
  unavailable?: string;              // set when the forge could not be read
  /** When this tick actually read the forge (ISO). The card's "Last checked" is this, not
   *  `pr.lastSeenEventAt` (the PR's own `updatedAt`, which sits still on a quiet PR); and
   *  `BugTaskStore.patchPr` uses it to refuse a view that was read before the one already
   *  stored. Always set by the watcher; an absent stamp is treated by the engine as "now". */
  checkedAt?: string;
  /** A PR found for the branch of a task that FAILED while pushing or opening one — i.e. opened
   *  outside AgentGrid. The engine decides what that means; `event` is null. */
  external?: true;
  /** The newest reviewer comment waiting out the quiet period; null: none waits (spec 2026-10-09 §5). Absent: not looked at. */
  commentsPending?: string | null;
  /** Why the user's own comments couldn't be told apart from reviewers'. */
  selfUnknown?: string;
}

/** Stages that fail BEFORE a pull request exists — the only failures after which someone may
 *  have opened the PR by hand. Not "pushing": that pushes to a PR AgentGrid already opened, so
 *  finding a PR on the branch there says nothing new. */
export const PR_STAGES = ["opening-pr", "creating-pr"] as const;
const lastRealStage = (t: BugTask) => [...t.history].reverse().find(h => h.stage !== "failed")?.stage;
/** A failed task worth asking the forge about: it broke on the way to a PR and none is recorded
 *  yet. Once one is (adopted, or found but not usable as-is), the watcher stops asking — the
 *  task carries its explanation, and Retry asks again when the human has acted on it. */
export const awaitsExternalPr = (t: BugTask): boolean =>
  t.stage === "failed" && !t.pr && (PR_STAGES as readonly string[]).includes(lastRealStage(t) ?? "");

export interface WatcherDeps {
  bugs: BugTaskStore;
  forge: ForgeAdapter | null;
  onFinding: (f: PrFinding) => void | Promise<void>;
  /** A tick that read the forge cleanly and found nothing different at all. It produces no
   *  finding — there is nothing to report about the PR — but the poll itself is news twice over:
   *  it is what the card's "Last checked" means, and it is the evidence that a "couldn't reach the
   *  forge" note is stale. Optional so a caller that needs neither can leave it off. */
  onChecked?: (taskId: string, checkedAt: string) => void | Promise<void>;
  now?: () => number;
  baseMs?: number;
  ceilingMs?: number;
  jitter?: (ms: number) => number;
  warnAfterFailures?: number;
  /** How long reviewers must be quiet before their comments start a round (default 10 minutes). */
  quietMs?: () => number;
}

interface Backoff { dueAt: number; intervalMs: number; failures: number; warned: boolean }

/** Fields whose change is "interesting": it either feeds `decide()` directly, or (headSha)
 *  is the only proof a push actually landed — no ReviewEvent kind represents one. A bare
 *  `lastSeenEventAt` bump with none of these different is comment/timestamp noise. */
function statesDiffer(pr: PrInfo, prev: PrInfo): boolean {
  return pr.state !== prev.state || pr.reviewDecision !== prev.reviewDecision
    || pr.checks !== prev.checks || pr.mergeable !== prev.mergeable || pr.headSha !== prev.headSha;
}

/**
 * The listed view says nothing changed. A listing may lack fields (Bitbucket's carries no checks or
 * mergeable): a missing field is not a change — except checks we were waiting on, which can only be
 * learnt by reading the PR. GitHub's updatedAt needn't move when CI finishes, so checks are compared too.
 */
function listedSame(now: PrInfo, prev: PrInfo): boolean {
  if (now.lastSeenEventAt !== prev.lastSeenEventAt || now.headSha !== prev.headSha || now.reviewDecision !== prev.reviewDecision || now.state !== prev.state) return false;
  if (now.checks === null ? prev.checks === "PENDING" : now.checks !== prev.checks) return false;
  return now.mergeable === null || now.mergeable === prev.mergeable;
}

/** How a human describes what reviewers said, for the agent's prompt. Exported so a manual
 *  "address comments" click (engine.ts's `recentComments`) renders the same way the watcher
 *  itself would, rather than inventing a second rendering. */
export function describeComments(events: ReviewEvent[]): string {
  return events.filter(e => !e.isBot && e.body.trim())
    .map(e => `${e.author}${e.state ? ` (${e.state.toLowerCase().replace(/_/g, " ")})` : ""}: ${e.body.trim()}`)
    .join("\n\n");
}

/**
 * Polls the forge for tasks resting on an open PR and reports what it finds. It never writes
 * task state — the engine is the only writer, which is what keeps Phase 1's serialisation and
 * gate guarantees intact. It watches only WATCHED_STAGES, never a task mid-agent-stage.
 */
export class PrWatcher {
  private timer: NodeJS.Timeout | null = null;
  private backoff = new Map<string, Backoff>();
  private now: () => number;
  private baseMs: number;
  private ceilingMs: number;
  private jitter: (ms: number) => number;
  private warnAfter: number;
  private quietMs: () => number;

  constructor(private deps: WatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.baseMs = deps.baseMs ?? 30_000;
    this.ceilingMs = deps.ceilingMs ?? 300_000;
    this.jitter = deps.jitter ?? (ms => ms + Math.floor(Math.random() * ms * 0.1));
    this.warnAfter = deps.warnAfterFailures ?? 3;
    this.quietMs = deps.quietMs ?? (() => 600_000);
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;                       // idempotent, like the engine's attach()
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Tick every watched task whose backoff is due. The watch list is rebuilt from the store
   *  each time, so a restart resumes watching with nothing needing to survive in memory. */
  async poll(): Promise<void> {
    const { bugs, forge } = this.deps;
    if (!forge) return;
    const watched = bugs.list().filter(t => WATCHED_STAGES.includes(t.stage) && t.pr);
    const orphans = bugs.list().filter(awaitsExternalPr);
    const live = new Set([...watched, ...orphans].map(t => t.id));
    const liveRepos = new Set(watched.map(t => `repo:${t.sourceRepo}`));
    for (const id of [...this.backoff.keys()]) if (!live.has(id) && !liveRepos.has(id)) this.backoff.delete(id);

    if (forge.listOpenPrs) await this.sweepByRepo(watched, forge);
    else for (const task of watched) {
      const b = this.backoff.get(task.id) ?? { dueAt: this.now(), intervalMs: this.baseMs, failures: 0, warned: false };
      if (this.now() < b.dueAt) { this.backoff.set(task.id, b); continue; }
      await this.tick(task, b, forge);
    }
    for (const task of orphans) {
      const b = this.backoff.get(task.id) ?? { dueAt: this.now(), intervalMs: this.baseMs, failures: 0, warned: false };
      if (this.now() < b.dueAt) { this.backoff.set(task.id, b); continue; }
      const checkedAt = new Date(this.now()).toISOString();
      const found = await forge.findPr(task.sourceRepo, task.branch).catch(() => null);
      this.schedule(task.id, b, false);
      if (found) await this.deps.onFinding({ taskId: task.id, pr: found, event: null, external: true, checkedAt });
    }
  }

  /**
   * One listing call per repo instead of one read per PR (spec 2026-10-07 §6). A PR is read on its own
   * only when its listed view moved (new activity, head or review) or it left the open list (merged or
   * closed — never read as "nothing changed"). A failed listing falls back to per-PR reads this once.
   */
  private async sweepByRepo(watched: BugTask[], forge: ForgeAdapter): Promise<void> {
    const byRepo = new Map<string, BugTask[]>();
    for (const t of watched) byRepo.set(t.sourceRepo, [...(byRepo.get(t.sourceRepo) ?? []), t]);
    for (const [repo, tasks] of byRepo) {
      const key = `repo:${repo}`;
      const rb = this.backoff.get(key) ?? { dueAt: this.now(), intervalMs: this.baseMs, failures: 0, warned: false };
      if (this.now() < rb.dueAt) { this.backoff.set(key, rb); continue; }
      const listed = await forge.listOpenPrs!(repo);
      const per = (t: BugTask): Backoff => this.backoff.get(t.id) ?? { dueAt: this.now(), intervalMs: this.baseMs, failures: 0, warned: false };
      if ("unavailable" in listed) {
        for (const t of tasks) await this.tick(t, per(t), forge);
        this.schedule(key, rb, false);
        continue;
      }
      const byNumber = new Map(listed.prs.map(p => [p.number, p]));
      let changed = false;
      for (const t of tasks) {
        const now = byNumber.get(t.pr!.number);
        if (!now) {
          // Not in the listing (merged or closed, opened by someone else, past the listing's limit): read it
          // on its own backoff, so it can't pin the whole repo's cadence.
          const b = per(t);
          if (this.now() < b.dueAt) { this.backoff.set(t.id, b); continue; }
          await this.tick(t, b, forge);
          continue;
        }
        if (listedSame(now, t.pr!) && !this.commentsDue(t)) { await this.deps.onChecked?.(t.id, new Date(this.now()).toISOString()); continue; }
        // The repo backs off only when reads find nothing new — a listing that merely looks different must not pin it.
        if (await this.tick(t, per(t), forge)) changed = true;
      }
      this.schedule(key, rb, changed);
    }
  }

  /** True when the read found something new (a state change, or an event to apply). */
  private async tick(task: BugTask, b: Backoff, forge: ForgeAdapter): Promise<boolean> {
    // Stamped before the call, so the stamp brackets the read rather than trailing it: two ticks
    // that overlap then order by when each one *started* looking, which is what makes an older
    // view recognisable as older.
    const checkedAt = new Date(this.now()).toISOString();
    const lookup = await forge.getPr(task.sourceRepo, task.pr!.number);

    if ("unavailable" in lookup) {
      // No information. Keep the last known view, keep backing off, and say so once we have
      // been blind for a while — a CLI failure must never look like a PR that vanished.
      b.failures += 1;
      const first = !b.warned && b.failures >= this.warnAfter;
      if (first) b.warned = true;
      this.schedule(task.id, b, false);
      if (first) await this.deps.onFinding({ taskId: task.id, pr: task.pr, event: null, unavailable: lookup.unavailable, checkedAt });
      return false;
    }
    b.failures = 0; b.warned = false;

    if (lookup.found === null) {
      this.schedule(task.id, b, true);
      await this.deps.onFinding({ taskId: task.id, pr: null, event: { type: "pr-closed" }, checkedAt });
      return true;
    }

    const pr = lookup.found;
    const prev = task.pr!;
    // Anything different at all is worth a card update. But a bare `lastSeenEventAt` bump —
    // a bot commenting on every CI run, say — must not by itself hold the interval at base:
    // that field alone says "something happened", not "something that matters happened".
    const stateChanged = statesDiffer(pr, prev);
    // A comment round whose quiet period has run out is due even on a PR that looks unchanged.
    const anyChange = pr.lastSeenEventAt !== prev.lastSeenEventAt || stateChanged || this.commentsDue(task);
    if (!anyChange) { this.schedule(task.id, b, false); await this.deps.onChecked?.(task.id, checkedAt); return false; }

    const d = await this.decide(task, pr, forge);
    const event = d.event;
    // Reset to base only when the tick produced an event, or the change was to a state field.
    // A bot-driven timestamp bump with no event and no state change still gets reported —
    // the card needs the latest `lastSeenEventAt` — but the backoff keeps growing regardless.
    this.schedule(task.id, b, event !== null || stateChanged);
    await this.deps.onFinding({ taskId: task.id, pr, event, checkedAt,
      ...(d.commentsPending !== undefined ? { commentsPending: d.commentsPending } : {}), ...(d.selfUnknown ? { selfUnknown: d.selfUnknown } : {}) });
    return event !== null || stateChanged;
  }

  /** Comments waited out the quiet period: read the PR again even if nothing about it moved. */
  private commentsDue(t: BugTask): boolean {
    return t.stage === "monitoring" && !!t.commentsPendingSince && this.now() - Date.parse(t.commentsPendingSince) >= this.quietMs();
  }

  /** Order matters: a conflicting PR cannot be merged, so conflict outranks an approval. A reviewer's comment starts a
   *  round once reviewers have been quiet for a while — all the comments in one round (spec 2026-10-09 §5). */
  private async decide(task: BugTask, pr: PrInfo, forge: ForgeAdapter): Promise<{ event: BugEvent | null; commentsPending?: string | null; selfUnknown?: string }> {
    if (pr.state === "MERGED") return { event: { type: "pr-merged" } };
    if (pr.state === "CLOSED") return { event: { type: "pr-closed" } };
    if (pr.mergeable === "CONFLICTING") return { event: { type: "conflicting" } };
    if (pr.checks === "FAILURE") {
      const answered = Boolean(pr.headSha && task.checksRoundHead && pr.headSha === task.checksRoundHead);
      if (!answered) return { event: { type: "checks-failed", checks: `checks are failing on ${pr.url}`, headSha: pr.headSha ?? null } };
    }
    const since = task.commentsSince ?? task.pr!.lastSeenEventAt;
    const human = (e: ReviewEvent) => e.kind !== "check" && !e.isBot && !e.isSelf;
    if (pr.reviewDecision === "CHANGES_REQUESTED" && task.stage === "monitoring") {
      const theirs = (await forge.listReviewEvents(task.sourceRepo, pr.number, since)).filter(human);
      if (theirs.length) return { event: { type: "review-changes-requested", comments: describeComments(theirs) || `changes were requested on ${pr.url}`, source: "forge", upTo: theirs.at(-1)!.at }, commentsPending: null };
    }
    if (pr.reviewDecision === "APPROVED") return { event: { type: "review-approved" } };
    // At the merge gate or in a conflict, comments wait: `commentsSince` stays put, so they're read once the task rests again.
    if (task.stage !== "monitoring") return { event: null };
    const who = forge.whoami ? await forge.whoami(task.sourceRepo).catch((e: Error) => ({ unavailable: e.message })) : null;
    const selfUnknown = who && "unavailable" in who ? { selfUnknown: who.unavailable } : {};
    const theirs = (await forge.listReviewEvents(task.sourceRepo, pr.number, since)).filter(e => human(e) && e.body.trim());
    if (!theirs.length) return { event: null, commentsPending: null, ...selfUnknown };
    const newest = theirs.at(-1)!.at;
    if (this.now() - Date.parse(newest) < this.quietMs()) return { event: null, commentsPending: newest, ...selfUnknown };
    return { event: { type: "review-changes-requested", comments: describeComments(theirs), source: "forge", upTo: newest }, commentsPending: null, ...selfUnknown };
  }

  private schedule(id: string, b: Backoff, changed: boolean): void {
    if (changed) {
      // Snap back: use the base interval now, and start doubling from it again next time.
      b.intervalMs = this.baseMs;
      b.dueAt = this.now() + this.jitter(b.intervalMs);
    } else {
      // Schedule the next check using the interval already in effect, THEN double it for
      // the round after — the doubling describes the gap after this wait, not before it.
      b.dueAt = this.now() + this.jitter(b.intervalMs);
      b.intervalMs = Math.min(b.intervalMs * 2, this.ceilingMs);
    }
    this.backoff.set(id, b);
  }
}
