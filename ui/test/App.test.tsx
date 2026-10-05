import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { api } from "../src/api";
import { notifyWaiting, notifyBugTask } from "../src/notify";
import type { Agent, BugTask, GridEvent, GridState, RoleDef } from "../src/types";

vi.mock("../src/api", () => ({
  api: {
    subscribe: vi.fn(),
    say: vi.fn(() => Promise.resolve({ via: "terminal" })),
    resetSession: vi.fn(() => Promise.resolve({})),
    renameSession: vi.fn(() => Promise.resolve()),
    agentTranscript: vi.fn(() => Promise.resolve({ sessionId: null, entries: [] })),
    listSessions: vi.fn(() => Promise.resolve([])),
    pickFolder: vi.fn(() => Promise.resolve(undefined)),
    listDir: vi.fn(() => Promise.resolve({ root: "/", path: "/", parent: null, entries: [] })),
    answer: vi.fn(() => Promise.resolve()),
    assign: vi.fn(() => Promise.resolve({})),
    cancel: vi.fn(() => Promise.resolve()),
    ack: vi.fn(() => Promise.resolve()),
    openTerminal: vi.fn(() => Promise.resolve({ opened: true, command: "" })),
    createAgent: vi.fn(() => Promise.resolve({})),
    memory: vi.fn(() => Promise.resolve([])),
    transcript: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock("../src/notify", () => ({
  notifyWaiting: vi.fn(),
  notifyFinished: vi.fn(),
  notifyBugTask: vi.fn(),
  setTitleCount: vi.fn(),
  settings: { notifyWaiting: true, notifyFinished: false },
}));

const role: RoleDef = {
  name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default",
  settingSources: [], allowedTools: [], maxTurns: 10, prompt: "",
};

function agent(id: string, state: Agent["state"]): Agent {
  return { id, role: "coder", repo: "/tmp", displayName: id, createdAt: new Date().toISOString(), state, currentAssignmentId: null };
}

function snapshot(agents: Agent[], bugTasks: BugTask[] = []): GridState { return { roles: [role], agents, assignments: [], liveSessions: [], sessionStatuses: [], bugTasks }; }

function bugTask(id: string, stage: BugTask["stage"], error: string | null = null, outcome: BugTask["outcome"] = null): BugTask {
  return {
    id, issue: { key: "PAY-42", title: "Boom", url: "u", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main",
    agentId: "bugfix@w", stage, gate: null, mergePolicy: "ask", mergeMethod: "squash", approvedHead: null,
    outcome, checksRoundHead: null, pr: null, prCheckedAt: null, costUsd: 0, history: [], error, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    feedbackRounds: 0, assumptions: [], assumptionsProblem: null, assumptionsToken: null,
  };
}

let onSnapshot: (s: GridState) => void;
let onChange: (e: GridEvent) => void;

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
  (api.subscribe as ReturnType<typeof vi.fn>).mockImplementation((snap: (s: GridState) => void, chg: (e: GridEvent) => void) => {
    onSnapshot = snap; onChange = chg;
    return () => {};
  });
});

describe("App notification transitions", () => {
  it("notifies on working->waiting but not on free->waiting", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([agent("A", "working"), agent("B", "free")])));
    act(() => onChange({ type: "agent", agent: agent("A", "waiting") }));
    expect(notifyWaiting).toHaveBeenCalledTimes(1);
    act(() => onChange({ type: "agent", agent: agent("B", "waiting") }));
    expect(notifyWaiting).toHaveBeenCalledTimes(1);
  });

  it("prunes removed agents so a re-added agent does not fire on a stale prev state", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([agent("A", "working")])));
    act(() => onChange({ type: "agent-removed", id: "A" }));
    act(() => onChange({ type: "agent", agent: agent("A", "waiting") }));
    expect(notifyWaiting).not.toHaveBeenCalled();
  });
});

describe("App bug-task notifications", () => {
  it("notifies naming the issue key on the moments a user isn't watching the grid", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([], [bugTask("bt1", "monitoring")])));

    act(() => onChange({ type: "bugtask", task: bugTask("bt1", "review-feedback") }));
    expect(notifyBugTask).toHaveBeenCalledWith(expect.stringContaining("PAY-42"), "attention");

    act(() => onChange({ type: "bugtask", task: bugTask("bt1", "approved") }));
    expect(notifyBugTask).toHaveBeenCalledWith(expect.stringMatching(/PAY-42.*ready to merge/i), "attention");

    act(() => onChange({ type: "bugtask", task: bugTask("bt1", "done", null, "merged") }));
    expect(notifyBugTask).toHaveBeenCalledWith(expect.stringMatching(/PAY-42.*merged/i), "finished");
  });

  // The classification is the server's own durable `outcome`, not the error text: a merged task
  // can legitimately carry an error (cleanup left behind), and a closed one's message is prose a
  // copy edit could reword.
  it("distinguishes a pr-closed ending from a merge by the recorded outcome, not the error text", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([], [bugTask("bt2", "monitoring")])));
    act(() => onChange({ type: "bugtask", task: bugTask("bt2", "done", "the forge says it went away", "closed") }));
    expect(notifyBugTask).toHaveBeenCalledWith(expect.stringMatching(/PAY-42.*closed without merging/i), "finished");
  });

  it("still calls a merge a merge when cleanup left something behind", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([], [bugTask("bt4", "monitoring")])));
    act(() => onChange({ type: "bugtask", task: bugTask("bt4", "done", "worktree cleanup incomplete: …", "merged") }));
    expect(notifyBugTask).toHaveBeenCalledWith(expect.stringMatching(/PAY-42.*merged/i), "finished");
    expect(notifyBugTask).not.toHaveBeenCalledWith(expect.stringMatching(/closed without merging/i), "finished");
  });

  it("does not notify on a snapshot that merely reflects the already-current stage", () => {
    render(<App />);
    act(() => onSnapshot(snapshot([], [bugTask("bt3", "monitoring")])));
    act(() => onSnapshot(snapshot([], [bugTask("bt3", "monitoring")])));
    expect(notifyBugTask).not.toHaveBeenCalled();
  });
});

describe("App Escape handling", () => {
  it("closes the spawn dialog first, then deselects on a second Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => onSnapshot(snapshot([agent("A", "free")])));

    await user.click(screen.getByTestId("tile-A"));
    expect(screen.getByTestId("tile-A")).toHaveClass("selected");

    await user.click(screen.getByRole("button", { name: /\+ Spawn/i }));
    expect(screen.getByText(/Spawn agent/i)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText(/Spawn agent/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("tile-A")).toHaveClass("selected");

    await user.keyboard("{Escape}");
    expect(screen.getByTestId("tile-A")).not.toHaveClass("selected");
  });
  it("the Bugs button switches to the bug screen and back, and the hash follows", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Bugs" }));
    expect(window.location.hash).toBe("#/bugs");
    expect(screen.getByTestId("bug-screen")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(window.location.hash).toBe("");
    expect(screen.queryByTestId("bug-screen")).toBeNull();
  });
  // Important #4: the grid's bare-key shortcuts act on an agent the bug screen does not show.
  it("number keys do nothing while the bug screen is showing", async () => {
    render(<App />);
    act(() => onSnapshot(snapshot([agent("a1", "free")])));
    await userEvent.click(screen.getByRole("button", { name: "Bugs" }));
    await userEvent.keyboard("1");
    await userEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(screen.getByText(/select an agent/i)).toBeInTheDocument();
  });
});
