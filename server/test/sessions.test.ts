import { describe, it, expect } from "vitest";
import { parseLiveSessions, mergeSessions, type LiveSession, type HistorySession } from "../src/sessions.js";
import type { Agent } from "../src/types.js";

const agent = (id: string, resumeSessionId?: string, currentAssignmentId: string | null = null): Agent =>
  ({ id, role: "coder", repo: "/r", displayName: id, createdAt: "", state: "free", currentAssignmentId, ...(resumeSessionId ? { resumeSessionId } : {}) });

describe("parseLiveSessions", () => {
  it("normalises `claude agents --json` output (interactive status / background state)", () => {
    const json = JSON.stringify([
      { id: "d85e", cwd: "/a", kind: "background", startedAt: 1, sessionId: "s-bg", name: "bg task", state: "blocked" },
      { pid: 1, cwd: "/b", kind: "interactive", startedAt: 2, sessionId: "s-it", name: "hrns-7e", status: "busy" },
      { pid: 2, cwd: "/c", kind: "interactive", startedAt: 3, sessionId: "s-idle", name: "x", status: "idle" },
    ]);
    expect(parseLiveSessions(json)).toEqual<LiveSession[]>([
      { sessionId: "s-bg", cwd: "/a", name: "bg task", kind: "background", status: "blocked", startedAt: 1, bgId: "d85e" },
      { sessionId: "s-it", cwd: "/b", name: "hrns-7e", kind: "interactive", status: "busy", startedAt: 2 },
      { sessionId: "s-idle", cwd: "/c", name: "x", kind: "interactive", status: "idle", startedAt: 3 },
    ]);
  });
  it("tolerates garbage", () => {
    expect(parseLiveSessions("not json")).toEqual([]);
    expect(parseLiveSessions("{}")).toEqual([]);
  });
});

describe("mergeSessions", () => {
  const live: LiveSession[] = [{ sessionId: "s1", cwd: "/a", name: "live one", kind: "interactive", status: "idle", startedAt: 5 }];
  const history: HistorySession[] = [
    { sessionId: "s1", cwd: "/a", title: "older title", lastActiveAt: 4 },
    { sessionId: "s2", cwd: "/b", title: "past", lastActiveAt: 9 },
    { sessionId: "s3", cwd: "/c", title: "adopted one", lastActiveAt: 8 },
    { sessionId: "s4", cwd: "/d", title: "grid run", lastActiveAt: 7 },
  ];
  it("live wins over history, history sorted newest first, adopted/grid sessions annotated", () => {
    const agents = [agent("coder@c", "s3"), agent("reviewer@d", undefined, "a9")];
    const assignmentSessionIds = new Map([["a9", "s4"]]);
    const out = mergeSessions(live, history, agents, assignmentSessionIds);
    expect(out.map(s => [s.sessionId, s.kind, s.status, s.agentId ?? null])).toEqual([
      ["s1", "interactive", "idle", null],
      ["s2", "history", "ended", null],
      ["s3", "history", "ended", "coder@c"],
      ["s4", "history", "ended", "reviewer@d"],
    ]);
    expect(out[0].title).toBe("live one");
    expect(out[1].canAdopt).toBe(true);
    expect(out[0].canAdopt).toBe(false); // live in a terminal
    expect(out[2].canAdopt).toBe(false); // already adopted
    expect(out[3].canAdopt).toBe(false); // belongs to a grid agent's assignment
  });
});
