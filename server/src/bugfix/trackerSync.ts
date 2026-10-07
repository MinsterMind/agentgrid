import type { BugTaskStore } from "./store.js";
import type { TrackerProvider, TransitionResult } from "./tracker.js";

/** The moments a ticket's status can follow (spec 2026-10-08 §4.3). */
export type Moment = "started" | "prOpened" | "merged" | "closed" | "noChange";
export const MOMENTS: Moment[] = ["started", "prOpened", "merged", "closed", "noChange"];
/** Per tracker project, per moment: the workflow transition to make, and the status it leads to. */
export type StatusMap = Record<string, Partial<Record<Moment, { transition: string; to: string }>>>;

/**
 * Moves tickets through the user's workflow as a fix goes on. Best effort, and never in the fix's
 * way: a move that fails is retried once, then written into the task's history and shown on its card.
 * Moves for one ticket run one at a time, in the order the moments happened — "In Review" can never
 * land after "Done".
 */
export class TrackerSync {
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<Promise<void>>();
  constructor(private deps: { tracker: TrackerProvider; bugs: BugTaskStore; statusMap: () => Promise<StatusMap | undefined>; retryMs?: number }) {}

  /** Queue the move this moment maps to, if any. Never throws. */
  moment(taskId: string, m: Moment): void {
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.apply(taskId, m)).catch(() => {});
    this.chains.set(taskId, next);
    this.pending.add(next);
    void next.finally(() => { this.pending.delete(next); if (this.chains.get(taskId) === next) this.chains.delete(taskId); });
  }

  /** Resolves once everything queued so far has settled. */
  async idle(): Promise<void> { while (this.pending.size) await Promise.all([...this.pending]); }

  private async apply(taskId: string, m: Moment): Promise<void> {
    const { bugs, tracker } = this.deps;
    let task; try { task = bugs.get(taskId); } catch { return; }      // dismissed meanwhile
    const target = (await this.deps.statusMap().catch(() => undefined))?.[task.trackerProject]?.[m];
    if (!target || !tracker.transition) return;
    const key = task.issue.key;
    const attempt = (): Promise<TransitionResult> => tracker.transition!(key, target.transition).catch((e: Error) => ({ ok: false as const, error: e.message }));
    let r = await attempt();
    if (!r.ok && await this.alreadyThere(key, target.to)) return this.note(taskId, `${key} is already ${target.to}`, null);
    if (!r.ok) { await new Promise(res => setTimeout(res, this.deps.retryMs ?? 30_000)); r = await attempt(); }
    if (r.ok) return this.note(taskId, `Moved ${key} to ${r.status || target.to}`, null);
    const why = `Couldn't move ${key} to ${target.to}: ${r.error}`;
    return this.note(taskId, why, why);
  }

  /** The move failed — is that because the ticket is there already? */
  private async alreadyThere(key: string, to: string): Promise<boolean> {
    try { return (await this.deps.tracker.fetchIssue(key)).status.trim().toLowerCase() === to.trim().toLowerCase(); }
    catch { return false; }
  }

  private async note(taskId: string, text: string, error: string | null): Promise<void> {
    let t; try { t = this.deps.bugs.get(taskId); } catch { return; }
    await this.deps.bugs.patch(taskId, { trackerSyncError: error, history: [...t.history, { stage: t.stage, at: new Date().toISOString(), note: text }] });
  }
}
