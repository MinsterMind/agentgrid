import { describe, it, expect } from "vitest";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds } from "../src/state/reducer";
import type { Agent, Assignment } from "../src/types";

const agent = (id: string, state: Agent["state"] = "free", cur: string | null = null): Agent =>
  ({ id, role: "coder", repo: "/r/" + id, displayName: id, createdAt: "2026-09-11T00:00:00Z", state, currentAssignmentId: cur });
const asg = (id: string, agentId: string, extra: Partial<Assignment> = {}): Assignment =>
  ({ id, agentId, prompt: "p", createdAt: new Date().toISOString(), startedAt: null, endedAt: null, sessionId: null,
     state: "working", activity: "", pending: null, outcome: null, error: null, turns: 0, costUsd: 0, ...extra });

describe("reducer", () => {
  it("snapshot replaces state, keeps selection", () => {
    const s = reducer({ ...initial, selectedId: "a" }, { type: "snapshot", state: { roles: [], agents: [agent("a")], assignments: [asg("a1", "a")] } });
    expect(s.agents.map(a => a.id)).toEqual(["a"]);
    expect(s.assignments.a1.id).toBe("a1");
    expect(s.selectedId).toBe("a");
  });
  it("change: agent upsert preserves order; removal clears selection", () => {
    let s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [agent("a"), agent("b")], assignments: [] } });
    s = reducer(s, { type: "change", event: { type: "agent", agent: agent("a", "working", "a1") } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "b"]);
    expect(s.agents[0].state).toBe("working");
    s = reducer(s, { type: "change", event: { type: "agent", agent: agent("c") } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "b", "c"]);
    s = reducer({ ...s, selectedId: "b" }, { type: "change", event: { type: "agent-removed", id: "b" } });
    expect(s.agents.map(a => a.id)).toEqual(["a", "c"]);
    expect(s.selectedId).toBeNull();
  });
  it("selectors", () => {
    const a = agent("a", "waiting", "a1"), b = agent("b", "done", "a2"), c = agent("c");
    const s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [a, b, c],
      assignments: [asg("a1", "a", { state: "waiting", costUsd: 0.5 }), asg("a2", "b", { state: "done", costUsd: 1.5 }), asg("a0", "b", { state: "done", costUsd: 9, createdAt: "2020-01-01T00:00:00Z" })] } });
    expect(assignmentFor(s, a)?.id).toBe("a1");
    expect(assignmentFor(s, c)).toBeNull();
    expect(counts(s)).toEqual({ free: 1, working: 0, waiting: 1, done: 1, failed: 0 });
    expect(todaySpend(s)).toBe(2);
    expect(waitingIds(s)).toEqual(["a"]);
  });
});
