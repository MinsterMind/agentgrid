import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTile } from "../src/components/AgentTile";
import { elapsed, usd } from "../src/format";
import type { Agent, Assignment, RoleDef } from "../src/types";

const role: RoleDef = { name: "devops", avatar: "🛠️", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" };
const agent = (state: Agent["state"], cur: string | null = "a41"): Agent =>
  ({ id: "devops@hrns", role: "devops", repo: "/u/MinsterMind/hrns", displayName: "Dev", createdAt: "", state, currentAssignmentId: cur });
const asg = (extra: Partial<Assignment>): Assignment =>
  ({ id: "a41", agentId: "devops@hrns", prompt: "restart", createdAt: "", startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), endedAt: null,
     sessionId: null, state: "working", activity: "Bash: kubectl get pods", pending: null, outcome: null, error: null, turns: 3, costUsd: 0.31, ...extra });
const base = { role, index: 0, selected: false, onSelect: vi.fn(), onAssign: vi.fn() };

describe("format", () => {
  it("elapsed and usd", () => {
    const now = Date.parse("2026-09-11T10:00:00Z");
    expect(elapsed("2026-09-11T09:54:00Z", now)).toBe("6m");
    expect(elapsed("2026-09-11T08:48:00Z", now)).toBe("1h 12m");
    expect(elapsed(null, now)).toBe("—");
    expect(usd(0.31)).toBe("$0.31");
  });
});

describe("AgentTile", () => {
  it("renders persona, repo basename, activity and footer for a working agent", () => {
    render(<AgentTile {...base} agent={agent("working")} assignment={asg({})} />);
    const tile = screen.getByTestId("tile-devops@hrns");
    expect(tile).toHaveAttribute("data-state", "working");
    expect(tile).toHaveTextContent("🛠️"); expect(tile).toHaveTextContent("Dev"); expect(tile).toHaveTextContent("devops"); expect(tile).toHaveTextContent("hrns");
    expect(tile).toHaveTextContent("Bash: kubectl get pods");
    expect(tile).toHaveTextContent("#a41"); expect(tile).toHaveTextContent("$0.31");
  });
  it("waiting shows a badge with the pending kind", () => {
    render(<AgentTile {...base} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: { kind: "question", toolUseId: "t", toolName: "AskUserQuestion", input: {}, suggestions: [] } })} />);
    expect(screen.getByText("question")).toBeInTheDocument();
  });
  it("done shows outcome; failed shows error", () => {
    const { rerender } = render(<AgentTile {...base} agent={agent("done")} assignment={asg({ state: "done", outcome: "Opened PR #88" })} />);
    expect(screen.getByTestId("tile-devops@hrns")).toHaveTextContent("Opened PR #88");
    rerender(<AgentTile {...base} agent={agent("failed")} assignment={asg({ state: "failed", error: "error_max_turns" })} />);
    expect(screen.getByTestId("tile-devops@hrns")).toHaveTextContent("error_max_turns");
  });
  it("free shows the assign box; Enter submits, Shift+Enter does not", async () => {
    const onAssign = vi.fn();
    render(<AgentTile {...base} onAssign={onAssign} agent={agent("free", null)} assignment={null} />);
    const box = screen.getByPlaceholderText(/assign work/i);
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onAssign).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onAssign).toHaveBeenCalledWith("devops@hrns", "line1\nline2");
  });
  it("click selects", async () => {
    const onSelect = vi.fn();
    render(<AgentTile {...base} onSelect={onSelect} agent={agent("working")} assignment={asg({})} />);
    await userEvent.click(screen.getByTestId("tile-devops@hrns"));
    expect(onSelect).toHaveBeenCalledWith("devops@hrns");
  });
});
