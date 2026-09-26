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
}

export interface WatcherDeps {
  bugs: BugTaskStore;
  forge: ForgeAdapter | null;
  onFinding: (f: PrFinding) => void | Promise<void>;
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
    const live = new Set(watched.map(t => t.id));
    for (const id of [...this.backoff.keys()]) if (!live.has(id)) this.backoff.delete(id);

    for (const task of watched) {
      const b = this.backoff.get(task.id) ?? { dueAt: this.now(), intervalMs: this.baseMs, failures: 0, warned: false };
      if (this.now() < b.dueAt) { this.backoff.set(task.id, b); continue; }
      await this.tick(task, b, forge);
    }
  }

  private async tick(task: BugTask, b: Backoff, forge: ForgeAdapter): Promise<void> {
    const lookup = await forge.getPr(task.sourceRepo, task.pr!.number);

    if ("unavailable" in lookup) {
      // No information. Keep the last known view, keep backing off, and say so once we have
      // been blind for a while — a CLI failure must never look like a PR that vanished.
      b.failures += 1;
      const first = !b.warned && b.failures >= this.warnAfter;
      if (first) b.warned = true;
      this.schedule(task.id, b, false);
      if (first) await this.deps.onFinding({ taskId: task.id, pr: task.pr, event: null, unavailable: lookup.unavailable });
      return;
    }
    b.failures = 0; b.warned = false;

    if (lookup.found === null) {
      this.schedule(task.id, b, true);
      await this.deps.onFinding({ taskId: task.id, pr: null, event: { type: "pr-closed" } });
      return;
    }

    const pr = lookup.found;
    const prev = task.pr!;
    // Anything different at all is worth a card update. But a bare `lastSeenEventAt` bump —
    // a bot commenting on every CI run, say — must not by itself hold the interval at base:
    // that field alone says "something happened", not "something that matters happened".
    const stateChanged = statesDiffer(pr, prev);
    const anyChange = pr.lastSeenEventAt !== prev.lastSeenEventAt || stateChanged;
    if (!anyChange) { this.schedule(task.id, b, false); return; }

    const event = await this.decide(task, pr, forge);
    // Reset to base only when the tick produced an event, or the change was to a state field.
    // A bot-driven timestamp bump with no event and no state change still gets reported —
    // the card needs the latest `lastSeenEventAt` — but the backoff keeps growing regardless.
    this.schedule(task.id, b, event !== null || stateChanged);
    await this.deps.onFinding({ taskId: task.id, pr, event });
  }

  /** Order matters: a conflicting PR cannot be merged, so conflict outranks an approval. */
  private async decide(task: BugTask, pr: PrInfo, forge: ForgeAdapter): Promise<BugEvent | null> {
    if (pr.state === "MERGED") return { type: "pr-merged" };
    if (pr.state === "CLOSED") return { type: "pr-closed" };
    if (pr.mergeable === "CONFLICTING") return { type: "conflicting" };
    if (pr.checks === "FAILURE") return { type: "checks-failed", checks: `checks are failing on ${pr.url}` };
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      const events = await forge.listReviewEvents(task.sourceRepo, pr.number, task.pr!.lastSeenEventAt);
      const comments = describeComments(events);
      return { type: "review-changes-requested", comments: comments || `changes were requested on ${pr.url}` };
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
