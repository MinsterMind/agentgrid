import type { Agent } from "../types";

export type SectionKey = "waiting" | "working" | "finished" | "free";
export interface Section { key: SectionKey; title: string; agents: Agent[] }

const TITLES: Record<SectionKey, string> = { waiting: "Needs you", working: "Working", finished: "Done · Failed", free: "Free" };
const keyOf = (a: Agent): SectionKey => a.state === "waiting" ? "waiting" : a.state === "working" ? "working" : a.state === "free" ? "free" : "finished";

/** Partition agents by attention priority; order inside a section is creation order. Empty sections are dropped. */
export function sectionize(agents: Agent[]): Section[] {
  const order: SectionKey[] = ["waiting", "working", "finished", "free"];
  return order.map(key => ({ key, title: TITLES[key], agents: agents.filter(a => keyOf(a) === key) })).filter(s => s.agents.length > 0);
}

/** Agents in on-screen order (section by section) — what the 1–9 keys index. */
export const visualOrder = (agents: Agent[]): Agent[] => sectionize(agents).flatMap(s => s.agents);
