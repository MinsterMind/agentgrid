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
}

interface Backoff { dueAt: number; intervalMs: number; failures: number; warned: boolean }

/** Fields whose change is "interesting": it either feeds `decide()` directly, or (headSha)
 *  is the only proof a push actually landed — no ReviewEvent kind represents one. A bare
 *  `lastSeenEventAt` bump with none of these different is comment/timestamp noise. */
function statesDiffer(pr: PrInfo, prev: PrInfo): boolean {
  return pr.state !== prev.state || pr.reviewDecision !== prev.reviewDecision
    || pr.checks !== prev.checks || pr.mergeable !== prev.mergeable || pr.headSha !== prev.headSha;
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

  constructor(private deps: WatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.baseMs = deps.baseMs ?? 30_000;
    this.ceilingMs = deps.ceilingMs ?? 300_000;
    this.jitter = deps.jitter ?? (ms => ms + Math.floor(Math.random() * ms * 0.1));
    this.warnAfter = deps.warnAfterFailures ?? 3;
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
    for (const id of [...this.backoff.keys()]) if (!live.has(id)) this.backoff.delete(id);

    for (const task of watched) {
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

  private async tick(task: BugTask, b: Backoff, forge: ForgeAdapter): Promise<void> {
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
      return;
    }
    b.failures = 0; b.warned = false;

    if (lookup.found === null) {
      this.schedule(task.id, b, true);
      await this.deps.onFinding({ taskId: task.id, pr: null, event: { type: "pr-closed" }, checkedAt });
      return;
    }

    const pr = lookup.found;
    const prev = task.pr!;
    // Anything different at all is worth a card update. But a bare `lastSeenEventAt` bump —
    // a bot commenting on every CI run, say — must not by itself hold the interval at base:
    // that field alone says "something happened", not "something that matters happened".
    const stateChanged = statesDiffer(pr, prev);
    const anyChange = pr.lastSeenEventAt !== prev.lastSeenEventAt || stateChanged;
    if (!anyChange) { this.schedule(task.id, b, false); await this.deps.onChecked?.(task.id, checkedAt); return; }

    const event = await this.decide(task, pr, forge);
    // Reset to base only when the tick produced an event, or the change was to a state field.
    // A bot-driven timestamp bump with no event and no state change still gets reported —
    // the card needs the latest `lastSeenEventAt` — but the backoff keeps growing regardless.
    this.schedule(task.id, b, event !== null || stateChanged);
    await this.deps.onFinding({ taskId: task.id, pr, event, checkedAt });
  }

  /** Order matters: a conflicting PR cannot be merged, so conflict outranks an approval. */
  private async decide(task: BugTask, pr: PrInfo, forge: ForgeAdapter): Promise<BugEvent | null> {
    if (pr.state === "MERGED") return { type: "pr-merged" };
    if (pr.state === "CLOSED") return { type: "pr-closed" };
    if (pr.mergeable === "CONFLICTING") return { type: "conflicting" };
    if (pr.checks === "FAILURE") {
      // A red build stands until CI runs again, so "still FAILURE" is not evidence this failure is
      // unanswered — the same shape as the standing CHANGES_REQUESTED below. Here the head IS the
      // evidence: a fix for failing checks always moves it, so a failure at a head a round was
      // already dispatched at is old news. Note what this deliberately does NOT do: dedupe on
      // "checks moved TO failure", which would never dispatch at all for a PR that reaches
      // `monitoring` already red (the stored view is FAILURE from the first look).
      //
      // No head on either side means no evidence either way — dispatch, the same fallback
      // `doPush` takes for an adapter that doesn't report `headSha`.
      const answered = Boolean(pr.headSha && task.checksRoundHead && pr.headSha === task.checksRoundHead);
      // Suppressed means "this red build is old news", not "this tick is old news": fall through
      // rather than returning, so a new human review arriving on the same tick is still seen. The
      // finding advances the `lastSeenEventAt` high-water mark either way, so a review dropped here
      // would be dropped for good.
      if (!answered) return { type: "checks-failed", checks: `checks are failing on ${pr.url}`, headSha: pr.headSha ?? null };
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      // GitHub holds `reviewDecision === "CHANGES_REQUESTED"` until a reviewer re-reviews, so
      // the decision by itself says nothing about whether THIS review has been answered. After
      // the server pushes round 1 the view still reads CHANGES_REQUESTED, and `statesDiffer`
      // only dedupes on "did a watched field move" — so any later change (a bot comment bumping
      // `lastSeenEventAt`, or the CI our own push re-triggered moving PENDING -> SUCCESS) would
      // re-fire a round with no real feedback in it, which `verify()` then fails for having no
      // new commits. The evidence a round needs is a NEW human voice on the PR since the view we
      // already have: at least one non-bot review or comment strictly after `lastSeenEventAt`.
      //
      // Deliberately NOT also suppressing while `pr.headSha` still equals the head the last
      // round pushed: a genuine re-review arrives without the head moving at all, so that
      // condition (alone, or conjoined with this one) would suppress exactly the case that must
      // still fire. This test is sufficient on its own, needs no new durable state, and is
      // decided by data the adapter already returns.
      const events = await forge.listReviewEvents(task.sourceRepo, pr.number, task.pr!.lastSeenEventAt);
      // The evidence is the event, not its rendered text: a reviewer may request changes with
      // an empty body, and that is still a new round.
      // `kind: "check"` is a human voice only by accident of attribution: `ReviewEvent.kind`
      // declares it (spec §6) and spec §4.4 is explicit that CI must wake the agent through the
      // status rollup, never through an event. An adapter that ever attributed one to a person
      // would otherwise fire a round whose feedback reads " (failure): unit tests".
      if (!events.some(e => e.kind !== "check" && !e.isBot)) return null;
      const comments = describeComments(events);
      return { type: "review-changes-requested", comments: comments || `changes were requested on ${pr.url}`, source: "forge" };
    }
    if (pr.reviewDecision === "APPROVED") return { type: "review-approved" };
    return null;                       // a comment, a pending check: the card updates, nothing runs
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
