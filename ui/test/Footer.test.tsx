import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { api } from "../src/api";

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


beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
  (api.subscribe as ReturnType<typeof vi.fn>).mockImplementation(() => () => {});
});

describe("Footer", () => {
  it("shows the grid's keys as kbd chips, and the bug screen's on the bug screen", async () => {
    render(<App />);
    const foot = document.querySelector(".foot")!;
    expect(Array.from(foot.querySelectorAll("kbd")).map(k => k.textContent)).toEqual(["1", "9", "A", "D", "O", "Esc"]);
    await userEvent.click(screen.getByRole("button", { name: /^Bugs/ }));
    expect(Array.from(document.querySelector(".foot")!.querySelectorAll("kbd")).map(k => k.textContent)).toEqual(["↑", "↓", "⏎", "Esc"]);
  });
});
