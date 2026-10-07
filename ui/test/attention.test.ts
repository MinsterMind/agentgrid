import { describe, it, expect } from "vitest";
import { attention, trailingQuestion } from "../src/state/attention";
import type { Agent, Assignment, PermissionRequest, SessionActivity } from "../src/types";

const agent = (state: Agent["state"]): Agent => ({ id: "rev@r", role: "reviewer", repo: "/r", displayName: "Rev", createdAt: "", state, currentAssignmentId: state === "free" ? null : "a1" });
const asg = (x: Partial<Assignment>): Assignment => ({ id: "a1", agentId: "rev@r", prompt: "review PR 7", createdAt: "", startedAt: null, endedAt: null, sessionId: "s", state: "done", activity: "", pending: null, outcome: null, error: null, turns: 1, costUsd: 0, ...x });
const PERM: PermissionRequest = { id: "pr1", agentId: "rev@r", source: "terminal", sessionId: "s", toolName: "Bash", input: { command: "gh pr comment" }, suggestedRule: "Bash(gh pr:*)", ruleIsBroad: false, createdAt: "" };
const act = (x: Partial<SessionActivity>): SessionActivity => ({ sessionId: "s", phase: "idle", lastMessage: "", lastPrompt: "", updatedAt: "", ...x });

describe("trailingQuestion", () => {
  it("finds a question the message ends on, through markdown and a trailing hint", () => {
    expect(trailingQuestion("Found 2 issues.\n\n**Want me to post them as PR comments?**")).toBe("Want me to post them as PR comments?");
    expect(trailingQuestion("Done.\n- Shall I re-run the tests? (yes/no)\n")).toBe("Shall I re-run the tests?");
  });
  it("ignores a question that isn't the last thing said", () => {
    expect(trailingQuestion("Is it safe? Yes — verified.\nAll good.")).toBeNull();
    expect(trailingQuestion("")).toBeNull(); expect(trailingQuestion(null)).toBeNull();
  });
});

describe("attention", () => {
  it("a pending request on a running task needs you", () => {
    expect(attention(agent("waiting"), asg({ state: "waiting" }), null)).toEqual({ kind: "request" });
    expect(attention(agent("working"), asg({ state: "working" }), act({ phase: "waiting" }))).toBeNull();
  });
  it("a run that finished by asking you something needs you", () => {
    expect(attention(agent("done"), asg({ outcome: "2 issues.\nPost them as comments?" }), null)).toEqual({ kind: "asked", question: "Post them as comments?" });
    expect(attention(agent("done"), asg({ outcome: "2 issues. Posted." }), null)).toBeNull();
  });
  it("the session's own log wins over the run's outcome", () => {
    // continued in the terminal and Claude Code is asking there (the hook's request) — even though the run says Done
    expect(attention(agent("done"), asg({ outcome: "ok" }), act({ phase: "working", runningTool: { name: "Bash", summary: "gh pr comment" } }), PERM))
      .toEqual({ kind: "request" });
    // Review Focus 4: a tool running in the terminal (auto mode) is not a request
    expect(attention(agent("done"), asg({ outcome: "ok" }), act({ phase: "working", runningTool: { name: "Bash", summary: "npm test" } }))).toBeNull();
    expect(attention({ ...agent("free"), resumeSessionId: "s" }, null, act({ phase: "working", runningTool: { name: "Bash", summary: "npm test" } }))).toBeNull();
    expect(attention(agent("done"), asg({ outcome: "Post them?" }), act({ phase: "working" }))).toBeNull();
    expect(attention(agent("done"), asg({ outcome: "ok" }), act({ phase: "idle", lastMessage: "Merged. Delete the branch?" }))).toEqual({ kind: "asked", question: "Merged. Delete the branch?" });
    // dismissed (acked): an old question is history — new work starts fresh — unless the session was adopted
    expect(attention(agent("free"), null, act({ phase: "idle", lastMessage: "Post them?" }))).toBeNull();
    expect(attention({ ...agent("free"), resumeSessionId: "s" }, null, act({ phase: "idle", lastMessage: "Post them?" }))).toEqual({ kind: "asked", question: "Post them?" });
    expect(attention(agent("free"), null, act({ phase: "waiting", question: { text: "Which env?", options: [], multiSelect: false } })))
      .toEqual({ kind: "terminal", text: "Asking you in the terminal: Which env?" });
  });
});
