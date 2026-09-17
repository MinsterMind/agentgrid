import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTile } from "../src/components/SessionTile";
import { AgentTile } from "../src/components/AgentTile";
import type { Agent, RoleDef, SessionInfo } from "../src/types";

const roles: RoleDef[] = [
  { name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" },
  { name: "reviewer", avatar: "🧐", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" },
];
const live: SessionInfo = { sessionId: "s-live", cwd: "/w/hrns", title: "hrns-7e", kind: "interactive", status: "busy", at: Date.now() - 120_000, canAdopt: true };

describe("SessionTile", () => {
  it("shows a live session as a ghost tile and pulls it in with the chosen role", async () => {
    const onPullIn = vi.fn(async () => {});
    render(<SessionTile session={live} roles={roles} onPullIn={onPullIn} />);
    const tile = screen.getByTestId("session-s-live");
    expect(tile).toHaveClass("livecard"); expect(tile).toHaveAttribute("data-state", "busy");
    expect(tile).toHaveTextContent("hrns-7e"); expect(tile).toHaveTextContent("hrns"); expect(tile).toHaveTextContent("tty"); expect(tile).toHaveTextContent("busy");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "reviewer");
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole("button", { name: /Pull in/ }));
    expect(onPullIn).not.toHaveBeenCalled();                       // declined the takeover confirm
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole("button", { name: /Pull in/ }));
    expect(onPullIn).toHaveBeenCalledWith("s-live", "reviewer", true); // terminal session → takeover
  });
  it("background sessions pull in without takeover or confirm", async () => {
    const onPullIn = vi.fn(async () => {});
    render(<SessionTile session={{ ...live, sessionId: "s-bg", kind: "background", bgId: "b1" }} roles={roles} onPullIn={onPullIn} />);
    await userEvent.click(screen.getByRole("button", { name: "Pull in" }));
    expect(onPullIn).toHaveBeenCalledWith("s-bg", "coder", false);
  });
});

describe("AgentTile with a live adopted session", () => {
  const agent: Agent = { id: "coder@hrns", role: "coder", repo: "/w/hrns", displayName: "Cody", createdAt: "", state: "free", currentAssignmentId: null, resumeSessionId: "s-live" };
  it("replaces the assign box with a live note while the terminal is open", () => {
    render(<AgentTile agent={agent} role={roles[0]} assignment={null} selected={false} index={0} onSelect={vi.fn()} onAssign={vi.fn()} live={live} />);
    expect(screen.getByTestId("live-note")).toHaveTextContent(/live in terminal/);
    expect(screen.queryByPlaceholderText(/assign work/i)).toBeNull();
  });
  it("shows the assign box once the session is no longer live", () => {
    render(<AgentTile agent={agent} role={roles[0]} assignment={null} selected={false} index={0} onSelect={vi.fn()} onAssign={vi.fn()} live={null} />);
    expect(screen.getByPlaceholderText(/assign work/i)).toBeInTheDocument();
  });
});
