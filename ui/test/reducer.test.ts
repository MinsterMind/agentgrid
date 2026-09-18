process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";
import { reducer, initial, assignmentFor, counts, todaySpend, waitingIds, unclaimedLiveSessions, liveSessionFor, activityFor, sessionIdFor } from "../src/state/reducer";
import type { Agent, Assignment } from "../src/types";

const agent = (id: string, state: Agent["state"] = "free", cur: string | null = null): Agent =>
  ({ id, role: "coder", repo: "/r/" + id, displayName: id, createdAt: "2026-09-11T00:00:00Z", state, currentAssignmentId: cur });
const asg = (id: string, agentId: string, extra: Partial<Assignment> = {}): Assignment =>
  ({ id, agentId, prompt: "p", createdAt: new Date().toISOString(), startedAt: null, endedAt: null, sessionId: null,
     state: "working", activity: "", pending: null, outcome: null, error: null, turns: 0, costUsd: 0, ...extra });

describe("reducer", () => {
  it("snapshot replaces state, keeps selection", () => {
    const s = reducer({ ...initial, selectedId: "a" }, { type: "snapshot", state: { roles: [], liveSessions: [], sessionStatuses: [], agents: [agent("a")], assignments: [asg("a1", "a")] } });
    expect(s.agents.map(a => a.id)).toEqual(["a"]);
    expect(s.assignments.a1.id).toBe("a1");
    expect(s.selectedId).toBe("a");
  });
  it("change: agent upsert preserves order; removal clears selection", () => {
    let s = reducer(initial, { type: "snapshot", state: { roles: [], liveSessions: [], sessionStatuses: [], agents: [agent("a"), agent("b")], assignments: [] } });
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
    const s = reducer(initial, { type: "snapshot", state: { roles: [], liveSessions: [], sessionStatuses: [], agents: [a, b, c],
      assignments: [asg("a1", "a", { state: "waiting", costUsd: 0.5 }), asg("a2", "b", { state: "done", costUsd: 1.5 }), asg("a0", "b", { state: "done", costUsd: 9, createdAt: "2020-01-01T00:00:00Z" })] } });
    expect(assignmentFor(s, a)?.id).toBe("a1");
    expect(assignmentFor(s, c)).toBeNull();
    expect(counts(s)).toEqual({ free: 1, working: 0, waiting: 1, done: 1, failed: 0 });
    expect(todaySpend(s)).toBe(2);
    expect(waitingIds(s)).toEqual(["a"]);
  });
  it("todaySpend uses local calendar day, not UTC day", () => {
    // now = 2026-09-12T01:00:00+05:30 == 2026-09-11T19:30:00Z
    const now = new Date("2026-09-12T01:00:00+05:30");
    const a = agent("a", "done", "a1"), b = agent("b", "done", "a2");
    const s = reducer(initial, { type: "snapshot", state: { roles: [], liveSessions: [], sessionStatuses: [], agents: [a, b], assignments: [
      // local 12 Sep 01:30 -> counts as "today" relative to `now` (local 12 Sep)
      asg("a1", "a", { state: "done", costUsd: 3, createdAt: "2026-09-11T20:00:00Z" }),
      // local 11 Sep 23:30 -> does not count as "today" relative to `now` (local 12 Sep)
      asg("a2", "b", { state: "done", costUsd: 5, createdAt: "2026-09-11T18:00:00Z" }),
    ] } });
    expect(todaySpend(s, now)).toBe(3);
  });
});

describe("live sessions", () => {
  const live = (id: string, agentId?: string) => ({ sessionId: id, cwd: "/w/x", title: id, kind: "interactive" as const, status: "idle" as const, at: 1, canAdopt: !agentId, ...(agentId ? { agentId } : {}) });
  it("snapshot + sessions event update liveSessions; unclaimed excludes owned ones", () => {
    let s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [{ ...agent("a"), resumeSessionId: "s-a" }], assignments: [asg("a1", "b", { sessionId: "s-b" })], liveSessions: [live("s-a"), live("s-b"), live("s-c"), live("s-d", "z")], sessionStatuses: [] } });
    expect(unclaimedLiveSessions(s).map(l => l.sessionId)).toEqual(["s-c"]);
    expect(liveSessionFor(s, { ...agent("a"), resumeSessionId: "s-a" })?.sessionId).toBe("s-a");
    expect(liveSessionFor(s, agent("q"))).toBeNull();
    s = reducer(s, { type: "change", event: { type: "sessions", sessions: [live("s-e")] } });
    expect(unclaimedLiveSessions(s).map(l => l.sessionId)).toEqual(["s-e"]);
  });
});

describe("grid-owned live sessions", () => {
  it("are neither 'live elsewhere' for their agent nor shown as unclaimed", () => {
    const a = { ...agent("a"), resumeSessionId: "s-a" };
    const s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [a], assignments: [], liveSessions: [
      { sessionId: "s-a", cwd: "/w", title: "s-a", kind: "interactive", status: "idle", at: 1, agentId: "a", owner: "grid", canAdopt: false },
      { sessionId: "s-z", cwd: "/w", title: "s-z", kind: "interactive", status: "idle", at: 1, owner: "grid", canAdopt: true },
    ], sessionStatuses: [] } });
    expect(liveSessionFor(s, a)).toBeNull();
    expect(unclaimedLiveSessions(s)).toEqual([]);
  });
});

describe("activity", () => {
  it("snapshot + session-status events map to agents via their session", () => {
    const a = { ...agent("a"), resumeSessionId: "s-a" };
    let s = reducer(initial, { type: "snapshot", state: { roles: [], agents: [a], assignments: [], liveSessions: [], sessionStatuses: [{ sessionId: "s-a", phase: "idle", lastMessage: "done", lastPrompt: "go", updatedAt: "t" }] } });
    expect(activityFor(s, a)?.lastMessage).toBe("done");
    s = reducer(s, { type: "change", event: { type: "session-status", status: { sessionId: "s-a", phase: "waiting", lastMessage: "?", lastPrompt: "go", updatedAt: "t2", question: { text: "Which?", options: ["x", "y"], multiSelect: false } } } });
    expect(activityFor(s, a)?.question?.options).toEqual(["x", "y"]);
    expect(sessionIdFor(s, agent("none"))).toBeNull();
  });
});
