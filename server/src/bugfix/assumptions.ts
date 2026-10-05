import type { Assumption, BugStage } from "./types.js";

export const ASSUMPTION_LIMITS = { items: 20, chars: 500 };
const KINDS = new Set(["assumption", "question"]);

/**
 * An agent stage's assumptions file → items for the task, or a one-line reason it could not be
 * used. Pure, and deliberately forgiving about packaging (a `{ assumptions: [...] }` wrapper) but
 * not about content: one bad item rejects the file, because silently dropping it would show the
 * human a list that looks complete and isn't. Never throws — reading assumptions must never be
 * the reason a stage fails.
 */
export function parseAssumptions(raw: string | null, meta: { token: string; stage: BugStage; round: number; at: string }):
  { items: Assumption[]; problem: string | null; read: boolean } {
  if (raw === null) return { items: [], problem: null, read: false };
  const where = `The ${meta.stage} stage's assumptions file`;
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { return { items: [], problem: `${where} is not valid JSON.`, read: true }; }
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { assumptions?: unknown }).assumptions)) {
    data = (data as { assumptions: unknown[] }).assumptions;
  }
  if (!Array.isArray(data)) return { items: [], problem: `${where} is not a list.`, read: true };

  for (const [i, item] of data.entries()) {
    const ok = item && typeof item === "object"
      && KINDS.has((item as { kind?: unknown }).kind as string)
      && typeof (item as { text?: unknown }).text === "string"
      && ((item as { text: string }).text).trim().length > 0;
    if (!ok) return { items: [], problem: `${where} has an unusable entry (item ${i + 1}): each needs kind "assumption" or "question" and non-empty text.`, read: true };
  }

  const notes: string[] = [];
  const kept = data.slice(0, ASSUMPTION_LIMITS.items) as Array<{ kind: Assumption["kind"]; text: string }>;
  if (data.length > kept.length) notes.push(`it listed ${data.length} items; the first ${ASSUMPTION_LIMITS.items} are shown`);
  let shortened = false;
  const items = kept.map((it, i): Assumption => {
    let text = it.text.trim();
    if (text.length > ASSUMPTION_LIMITS.chars) { text = text.slice(0, ASSUMPTION_LIMITS.chars - 1) + "…"; shortened = true; }
    return { id: `${meta.token}:${i}`, stage: meta.stage, round: meta.round, kind: it.kind, text, at: meta.at };
  });
  if (shortened) notes.push(`long entries were shortened to ${ASSUMPTION_LIMITS.chars} characters`);
  return { items, problem: notes.length ? `${where}: ${notes.join("; ")}.` : null, read: true };
}
