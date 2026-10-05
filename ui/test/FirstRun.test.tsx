import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRun } from "../src/components/FirstRun";
import type { SetupReport } from "../src/types";

const setup = { ready: false, wired: false, addCommand: "", discovery: { servers: [], problems: [] }, checks: [
  { id: "tracker", state: "ok", blocks: true, detail: "" }, { id: "forge", state: "missing", blocks: true, detail: "" }, { id: "role", state: "ok", blocks: true, detail: "" },
] } as SetupReport;
const props = (over = {}) => ({ liveSessions: 2, setup, onNewAgent: vi.fn(), onSessions: vi.fn(), onFixBug: vi.fn(), onOpenSettings: vi.fn(), ...over });

describe("FirstRun", () => {
  it("explains the app in one line and offers three ways to start, each saying what happens", async () => {
    const p = props(); render(<FirstRun {...p} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Run several Claude Code agents side by side.");
    await userEvent.click(screen.getByRole("button", { name: "Create an agent" })); expect(p.onNewAgent).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show sessions" })); expect(p.onSessions).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Start a bug fix" })); expect(p.onFixBug).toHaveBeenCalled();
  });
  // Review Focus 5
  it("counts the Claude Code sessions already running, and says when there are none", () => {
    const { rerender } = render(<FirstRun {...props()} />);
    expect(screen.getByText(/already open in 2 terminals/)).toBeInTheDocument();
    rerender(<FirstRun {...props({ liveSessions: 0 })} />);
    expect(screen.getByRole("button", { name: "Show sessions" })).toBeDisabled();
    expect(screen.getByText(/none open right now/)).toBeInTheDocument();
  });
  it("shows readiness as chips, only needed for bug fixes, with a way to fix it", async () => {
    const p = props(); render(<FirstRun {...p} />);
    expect(screen.getByText("Forge").closest(".chip")).toHaveClass("amber");
    expect(screen.getByText(/only needed for bug fixes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fix it" })); expect(p.onOpenSettings).toHaveBeenCalled();
  });
  it("teaches the colour language in three steps", () => {
    render(<FirstRun {...props()} />);
    const how = screen.getByRole("complementary", { name: "How AgentGrid works" });
    expect(how.querySelectorAll("li")).toHaveLength(3);
  });
});
