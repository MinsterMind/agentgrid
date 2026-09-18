import { describe, it, expect } from "vitest";
import { parseLiveSessions, mergeSessions, LiveSessionWatcher, takeOverSession, processAlive, type LiveSession, type HistorySession } from "../src/sessions.js";
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
      { sessionId: "s-it", cwd: "/b", name: "hrns-7e", kind: "interactive", status: "busy", startedAt: 2, pid: 1 },
      { sessionId: "s-idle", cwd: "/c", name: "x", kind: "interactive", status: "idle", startedAt: 3, pid: 2 },
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
    expect(out[0].title).toBe("older title"); // history (customTitle) wins over the process name
    expect(out[1].canAdopt).toBe(true);
    expect(out[0].canAdopt).toBe(true); // live sessions can be pulled in too
    expect(out[2].canAdopt).toBe(false); // already adopted
    expect(out[3].canAdopt).toBe(false); // belongs to a grid agent's assignment
  });
});

describe("LiveSessionWatcher", () => {
  const mk = (sid: string, status: "busy" | "idle" = "idle"): LiveSession => ({ sessionId: sid, cwd: "/a", name: sid, kind: "interactive", status, startedAt: 1 });
  it("reports only real changes and tracks liveness", async () => {
    let list: LiveSession[] = [mk("a")];
    const changes: LiveSession[][] = [];
    const w = new LiveSessionWatcher(async () => list, l => changes.push(l), 1000);
    await w.poll(); await w.poll();
    expect(changes).toHaveLength(1);
    expect(w.isLive("a")).toBe(true); expect(w.isLive("b")).toBe(false);
    list = [mk("a", "busy"), mk("b")]; await w.poll();
    expect(changes).toHaveLength(2); expect(w.current.map(s => s.sessionId)).toEqual(["a", "b"]);
    list = []; await w.poll();
    expect(w.isLive("a")).toBe(false);
  });
  it("keeps the last list when the fetch fails", async () => {
    let fail = false;
    const w = new LiveSessionWatcher(async () => { if (fail) throw new Error("x"); return [mk("a")]; }, () => {}, 1000);
    await w.poll(); fail = true; await w.poll();
    expect(w.isLive("a")).toBe(true);
  });
});

describe("takeOverSession", () => {
  const it0: LiveSession = { sessionId: "s", cwd: "/a", name: "s", kind: "interactive", status: "idle", startedAt: 1, pid: 4242 };
  it("kills the pid and resolves once the session leaves the live list", async () => {
    let polls = 0; const killed: number[] = [];
    const out = await takeOverSession(it0, { kill: pid => killed.push(pid), fetch: async () => (++polls < 3 ? [it0] : []), stepMs: 1 });
    expect(killed).toEqual([4242]); expect(polls).toBe(3); expect(out).toEqual([]);
  });
  it("times out with a 504 if the session never closes", async () => {
    await expect(takeOverSession(it0, { kill: () => {}, fetch: async () => [it0], timeoutMs: 5, stepMs: 1 })).rejects.toMatchObject({ status: 504 });
  });
  it("refuses background sessions and pid-less ones", async () => {
    await expect(takeOverSession({ ...it0, kind: "background" }, { fetch: async () => [] })).rejects.toMatchObject({ status: 400 });
    await expect(takeOverSession({ ...it0, pid: undefined }, { fetch: async () => [] })).rejects.toMatchObject({ status: 409 });
  });
  it("processAlive: own pid alive, absurd pid dead, unknown counts alive", () => {
    expect(processAlive(process.pid)).toBe(true); expect(processAlive(2 ** 22 - 7)).toBe(false); expect(processAlive(undefined)).toBe(true);
  });
});

describe("grid-owned live sessions", () => {
  it("marks live sessions run by our own ptys with owner:grid", () => {
    const live: LiveSession[] = [
      { sessionId: "ours", cwd: "/a", name: "ours", kind: "interactive", status: "idle", startedAt: 1, pid: 100 },
      { sessionId: "theirs", cwd: "/b", name: "theirs", kind: "interactive", status: "idle", startedAt: 1, pid: 200 },
    ];
    const out = mergeSessions(live, [], [], new Map(), new Set([100]));
    expect(out.map(s => [s.sessionId, s.owner ?? null])).toEqual([["ours", "grid"], ["theirs", null]]);
  });
});
