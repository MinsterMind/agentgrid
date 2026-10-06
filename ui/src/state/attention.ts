import type { Agent, Assignment, SessionActivity } from "../types";

/** Why an agent needs you, if it does. `request`: a pending permission or question on a running task.
 *  `terminal`: its session is waiting in the embedded terminal. `asked`: it finished by asking you something. */
export type Attention = { kind: "request" } | { kind: "terminal"; text: string } | { kind: "asked"; question: string } | null;

/** The question a message ends on, if it ends on one — markdown and a trailing "(yes/no)" hint stripped. */
export function trailingQuestion(text: string | null | undefined): string | null {
  const last = (text ?? "").split("\n").map(l => l.trim()).filter(Boolean).at(-1);
  if (!last) return null;
  const clean = last.replace(/^(?:[-*>]|\d+[.)])\s+/, "").replace(/[*_`]/g, "").replace(/\s*\([^()]*\)$/, "").trim();
  return clean.endsWith("?") ? clean.slice(0, 240) : null;
}

/** One rule for "needs you", shared by the card, the NEEDS YOU counter, the sections and the title.
 *  The session's own log (activity) is the freshest word on a session that isn't running in the grid —
 *  it covers work continued in the terminal; a finished run's outcome is the fallback when there is no log. */
export function attention(agent: Agent, a: Assignment | null, activity: SessionActivity | null | undefined): Attention {
  if (agent.state === "waiting") return { kind: "request" };
  if (agent.state === "working") return null;
  if (activity && activity.phase !== "unknown") {
    if (activity.phase === "waiting") return { kind: "terminal", text: activity.question ? `Asking you in the terminal: ${activity.question.text}` : `Needs approval in the terminal: ${activity.pendingTool?.name ?? "a tool"}` };
    if (activity.phase === "working") return null;
    // A dismissed run's question is history: new work on a non-adopted agent starts a fresh conversation.
    if (agent.state === "free" && !agent.resumeSessionId) return null;
    const q = trailingQuestion(activity.lastMessage);
    return q ? { kind: "asked", question: q } : null;
  }
  const q = agent.state === "done" ? trailingQuestion(a?.outcome) : null;
  return q ? { kind: "asked", question: q } : null;
}
