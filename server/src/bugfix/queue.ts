/**
 * At most `cap()` bug-fix agent runs at once (spec 2026-10-07 §5). The rest wait in arrival order.
 * The queue only decides who may start; the engine owns starting and ending runs, and must release a
 * slot on every way a run can end — finished, failed at dispatch, or the task going terminal.
 */
export class RunQueue {
  private run = new Set<string>();
  private wait: string[] = [];
  constructor(private cap: () => number) {}

  /** True: start now (the slot is taken). False: in line, once. A task that already holds a slot keeps it. */
  tryStart(taskId: string): boolean {
    if (this.run.has(taskId)) return true;
    if (this.run.size < this.cap()) { this.wait = this.wait.filter(x => x !== taskId); this.run.add(taskId); return true; }
    if (!this.wait.includes(taskId)) this.wait.push(taskId);
    return false;
  }

  /** Free `taskId`'s slot (and its place in line); returns the waiting tasks that now start, their slots taken. */
  release(taskId: string): string[] {
    this.run.delete(taskId);
    this.remove(taskId);
    return this.drain();
  }

  /** Start as many waiting tasks as now fit — after a release, or after the cap was raised. */
  drain(): string[] {
    const started: string[] = [];
    while (this.run.size < this.cap() && this.wait.length) { const next = this.wait.shift()!; this.run.add(next); started.push(next); }
    return started;
  }

  remove(taskId: string): void { this.wait = this.wait.filter(x => x !== taskId); }
  running(): string[] { return [...this.run]; }
  waiting(): string[] { return [...this.wait]; }
}
