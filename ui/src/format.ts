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

/** "6 min ago" — for the screen; the absolute time goes in a title attribute beside it. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
