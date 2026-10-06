import type { Agent } from "../types";

export type SectionKey = "waiting" | "working" | "finished" | "free";
export interface Section { key: SectionKey; title: string; hint: string; agents: Agent[] }

const TITLES: Record<SectionKey, string> = { waiting: "Needs you", working: "Working", finished: "Done / Failed", free: "Idle" };
/** One plain line per section, so a first-time user knows what they are looking at and what to do. */
const HINTS: Record<SectionKey, string> = {
  waiting: "Agents waiting for your answer before they can continue.",
  working: "Running now. You don't need to watch them.",
  finished: "Finished. Read the outcome, then assign more work or dismiss.",
  free: "Ready for a new task.",
};
const keyOf = (a: Agent, needs: (a: Agent) => boolean): SectionKey => needs(a) ? "waiting" : a.state === "waiting" ? "waiting" : a.state === "working" ? "working" : a.state === "free" ? "free" : "finished";

/** Partition agents by attention priority; order inside a section is creation order. Empty sections are dropped. */
/** `needs`: agents that need you for a reason other than a pending request (a question, a waiting terminal). */
export function sectionize(agents: Agent[], needs: (a: Agent) => boolean = () => false): Section[] {
  const order: SectionKey[] = ["waiting", "working", "finished", "free"];
  return order.map(key => ({ key, title: TITLES[key], hint: HINTS[key], agents: agents.filter(a => keyOf(a, needs) === key) })).filter(s => s.agents.length > 0);
}

/** Agents in on-screen order (section by section) — what the 1–9 keys index. */
export const visualOrder = (agents: Agent[], needs?: (a: Agent) => boolean): Agent[] => sectionize(agents, needs).flatMap(s => s.agents);
