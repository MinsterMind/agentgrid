import type { BugTask } from "./types";

export function elapsed(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return "—";
  const m = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * Did a finished bug task merge? The server records the answer explicitly the moment it knows
 * it (`outcome`: "merged" on the confirmed-merge transition, "closed" on a pr-closed ending), so
 * nothing here infers it from prose or from a PR view a racing poll can leave stale. The
 * `pr.state` fallback exists only for tasks written before that field did.
 */
export function bugMerged(task: Pick<BugTask, "outcome" | "pr">): boolean {
  return task.outcome ? task.outcome === "merged" : task.pr?.state === "MERGED";
}
