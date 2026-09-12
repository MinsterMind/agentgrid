export function elapsed(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return "—";
  const m = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
