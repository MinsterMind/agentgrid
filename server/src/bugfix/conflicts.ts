import type { BugTaskStore } from "./store.js";
import type { GitOps } from "./git.js";
import type { BugEvent, BugStage, BugTask } from "./types.js";

/** Where a PR rests, so a merge elsewhere can make it conflict (spec 2026-10-07 §4.1). */
const RESTING: BugStage[] = ["monitoring", "approved", "conflict"];

export interface ConflictWatcherDeps {
  bugs: BugTaskStore;
  git: GitOps;
  /** A transition for the engine to apply (`conflicting` or `conflict-cleared`); the watcher never writes tasks. */
  onFinding: (f: { taskId: string; event: BugEvent }) => Promise<void>;
  /** Why the check couldn't run for a task (shown on its card), or null once a check succeeds again. */
  onProblem?: (taskId: string, message: string | null) => Promise<void>;
  intervalMs?: number;
  poolSize?: number;
}

/**
 * Notices conflicts across hundreds of open PRs without spending forge API calls. A conflict can only
 * appear when a base branch moves, so: per repo, read each base's tip with `git ls-remote`; only when a
 * tip moved (or a task joined, changed stage, or the repo was nudged — e.g. a PR just merged) fetch once,
 * then run `git merge-tree` for every resting task. A thousand branches is a few seconds of local git.
 */
export class ConflictWatcher {
  private tips = new Map<string, Map<string, string>>();
  private seen = new Map<string, Map<string, BugStage>>();
  private nudged = new Set<string>();
  private troubled = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private deps: ConflictWatcherDeps) {}

  /** Re-check this repo on the next pass even if no base moved. */
  nudge(repo: string): void { this.nudged.add(repo); }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const byRepo = new Map<string, BugTask[]>();
      for (const t of this.deps.bugs.list()) {
        if (!RESTING.includes(t.stage) || !t.pr) continue;
        byRepo.set(t.sourceRepo, [...(byRepo.get(t.sourceRepo) ?? []), t]);
      }
      for (const [repo, tasks] of byRepo) await this.checkRepo(repo, tasks);
    } finally {
      this.running = false;
    }
  }

  private async checkRepo(repo: string, tasks: BugTask[]): Promise<void> {
    const { git } = this.deps;
    const known = this.tips.get(repo) ?? new Map<string, string>();
    const bases = [...new Set(tasks.map(t => t.baseBranch))];
    const tips = new Map<string, string>();
    for (const b of bases) {
      const tip = await git.remoteTip(repo, b);
      if (!tip) return this.problem(tasks, `couldn't read origin/${b}`);
      tips.set(b, tip);
    }
    const seen = this.seen.get(repo) ?? new Map<string, BugStage>();
    const moved = bases.some(b => known.get(b) !== tips.get(b));
    const changed = tasks.some(t => seen.get(t.id) !== t.stage);
    if (!moved && !changed && !this.nudged.has(repo)) return;

    try { await git.fetch(repo); }
    catch (err) { return this.problem(tasks, (err as Error).message); }
    this.nudged.delete(repo);
    this.tips.set(repo, tips);
    this.seen.set(repo, new Map(tasks.map(t => [t.id, t.stage])));

    await pool(tasks, this.deps.poolSize ?? 4, async t => {
      if (this.troubled.delete(t.id)) await this.deps.onProblem?.(t.id, null);
      const files = await git.conflictFiles(t.worktree, `origin/${t.baseBranch}`, `origin/${t.branch}`);
      if (files === null) return;                           // couldn't tell: never a reason to change anything
      if (files.length && t.stage !== "conflict") await this.deps.onFinding({ taskId: t.id, event: { type: "conflicting", files, base: t.baseBranch } });
      else if (!files.length && t.stage === "conflict") await this.deps.onFinding({ taskId: t.id, event: { type: "conflict-cleared" } });
    });
  }

  /** The check couldn't run: say so on each card, keep the repo due, and never clear a conflict over it. */
  private async problem(tasks: BugTask[], reason: string): Promise<void> {
    this.nudged.add(tasks[0].sourceRepo);
    for (const t of tasks) { this.troubled.add(t.id); await this.deps.onProblem?.(t.id, `Couldn't check for conflicts: ${reason}`); }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Run `fn` over `items`, at most `size` at a time. */
async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
