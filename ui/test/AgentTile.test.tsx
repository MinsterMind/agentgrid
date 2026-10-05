import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  const permission = { kind: "permission" as const, toolUseId: "tu1", toolName: "Bash", input: { command: "kubectl rollout restart deploy/api" }, suggestions: [{}] };
  const oneQuestion = { kind: "question" as const, toolUseId: "tu2", toolName: "AskUserQuestion" as const, suggestions: [],
    input: { questions: [{ question: "Which env?", header: "Env", options: [{ label: "staging", description: "" }, { label: "prod", description: "" }] }] } };

  it("names every state in words", () => {
    for (const [state, word] of [["working", "Working"], ["waiting", "Needs you"], ["done", "Done"], ["failed", "Failed"], ["free", "Idle"]] as const) {
      const { unmount } = render(<AgentTile {...base} agent={agent(state, state === "free" ? null : "a41")} assignment={state === "free" ? null : asg({ state: state === "waiting" ? "waiting" : state })} />);
      expect(screen.getByTestId("tile-state")).toHaveTextContent(word);
      unmount();
    }
  });

  it("shows the exact command and answers Allow / Deny right on the tile", async () => {
    const onDecide = vi.fn(); const onSelect = vi.fn();
    render(<AgentTile {...base} onSelect={onSelect} onDecide={onDecide} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: permission })} />);
    const card = screen.getByTestId("tile-request");
    expect(card).toHaveTextContent("Wants to run a shell command");
    expect(card).toHaveTextContent("kubectl rollout restart deploy/api");
    await userEvent.click(within(card).getByRole("button", { name: "Allow" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu1", { kind: "allow" });
    await userEvent.click(within(card).getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu1", { kind: "deny" });
    expect(onSelect).not.toHaveBeenCalled();                          // Review Focus 1: the tile underneath is not selected
    expect(within(card).queryByRole("button", { name: /always/i })).toBeNull();
  });

  it("answers a single one-choice question with its options", async () => {
    const onDecide = vi.fn();
    render(<AgentTile {...base} onDecide={onDecide} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: oneQuestion })} />);
    const card = screen.getByTestId("tile-request");
    expect(card).toHaveTextContent("Which env?");
    await userEvent.click(within(card).getByRole("button", { name: "staging" }));
    expect(onDecide).toHaveBeenCalledWith("devops@hrns", "tu2", { kind: "answers", answers: { "Which env?": "staging" } });
  });

  // Review Focus 3
  it("sends a multi-part question to the side panel instead of answering half of it", async () => {
    const onSelect = vi.fn();
    const multi = { ...oneQuestion, input: { questions: [oneQuestion.input.questions[0], { question: "Region?", header: "Region", options: [{ label: "eu", description: "" }] }] } };
    render(<AgentTile {...base} onSelect={onSelect} onDecide={vi.fn()} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: multi })} />);
    const card = screen.getByTestId("tile-request");
    expect(within(card).queryByRole("button", { name: "staging" })).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: /answer in the side panel/i }));
    expect(onSelect).toHaveBeenCalledWith("devops@hrns");
  });

  // Review Focus 2
  it("waiting with nothing pending yet says so, with no empty buttons", () => {
    render(<AgentTile {...base} onDecide={vi.fn()} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: null })} />);
    expect(screen.getByTestId("tile-request")).toHaveTextContent(/waiting for you/i);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
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

describe("AgentTile task line", () => {
  it("shows the current task title on a working tile and the last prompt for an idle adopted one", () => {
    const { rerender } = render(<AgentTile {...base} agent={agent("working")} assignment={asg({ prompt: "Rotate the refresh token\nand add tests" })} />);
    const title = screen.getByTestId("tile-devops@hrns").querySelector(".tasktitle")!;
    expect(title).toHaveTextContent("Rotate the refresh token"); expect(title).not.toHaveTextContent("add tests");
    rerender(<AgentTile {...base} agent={{ ...agent("free", null), resumeSessionId: "s" }} assignment={null}
      activity={{ sessionId: "s", phase: "waiting", lastMessage: "", lastPrompt: "deploy staging", updatedAt: "", pendingTool: { name: "Bash", summary: "kubectl apply" } }} />);
    expect(screen.getByTestId("tile-devops@hrns").querySelector(".tasktitle")).toHaveTextContent("deploy staging");
    expect(screen.getByTestId("tile-phase")).toHaveTextContent("Needs approval in the terminal: Bash");
  });

  // I3
  it("the 'open it' card opens the agent when clicked", async () => {
    const onSelect = vi.fn();
    render(<AgentTile {...base} onSelect={onSelect} onDecide={vi.fn()} agent={agent("waiting")} assignment={asg({ state: "waiting", pending: null })} />);
    await userEvent.click(screen.getByTestId("tile-request"));
    expect(onSelect).toHaveBeenCalledWith("devops@hrns");
  });

  // I4
  it("an idle agent waiting on you in its terminal says Needs you, not Idle", () => {
    render(<AgentTile {...base} agent={{ ...agent("free", null), resumeSessionId: "s" }} assignment={null}
      activity={{ sessionId: "s", phase: "waiting", lastMessage: "", lastPrompt: "", updatedAt: "", pendingTool: { name: "Bash", summary: "x" } }} />);
    const st = screen.getByTestId("tile-state");
    expect(st).toHaveTextContent("Needs you");
    expect(st).toHaveClass("waiting");
  });

});
