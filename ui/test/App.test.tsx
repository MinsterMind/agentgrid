import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { api } from "../src/api";
import { notifyWaiting } from "../src/notify";
import type { Agent, GridEvent, GridState, RoleDef } from "../src/types";

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

function snapshot(agents: Agent[]): GridState { return { roles: [role], agents, assignments: [], liveSessions: [], sessionStatuses: [] }; }

let onSnapshot: (s: GridState) => void;
let onChange: (e: GridEvent) => void;

beforeEach(() => {
  vi.clearAllMocks();
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
});
