import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidePanel } from "../src/components/SidePanel";
import type { Agent, Assignment, RoleDef } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  transcript: vi.fn(async () => [{ ts: "", role: "assistant", kind: "tool_use", text: "Bash: kubectl get pods" }]),
  memory: vi.fn(async () => [{ file: "ns.md", name: "staging-ns", description: "namespace is hrns-stg" }]),
} }));

const role: RoleDef = { name: "devops", avatar: "🛠️", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" };
const agent: Agent = { id: "devops@hrns", role: "devops", repo: "/u/hrns", displayName: "Dev", createdAt: "", state: "waiting", currentAssignmentId: "a41" };
const asg: Assignment = { id: "a41", agentId: "devops@hrns", prompt: "Restart staging", createdAt: "", startedAt: null, endedAt: null, sessionId: "s1", state: "waiting",
  activity: "x", pending: { kind: "permission", toolUseId: "t1", toolName: "Bash", input: { command: "kubectl rollout restart" }, suggestions: [] }, outcome: null, error: null, turns: 2, costUsd: 0.3 };
const fns = { onDecide: vi.fn(), onCancel: vi.fn(), onAck: vi.fn(), onOpenTerminal: vi.fn() };
beforeEach(() => vi.clearAllMocks());

describe("SidePanel", () => {
  it("shows task, transcript, pending prompt, memory and actions", async () => {
    render(<SidePanel agent={agent} role={role} assignment={asg} {...fns} />);
    expect(screen.getByText("Restart staging")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Bash: kubectl get pods")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/staging-ns/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(fns.onDecide).toHaveBeenCalledWith("devops@hrns", "t1", { kind: "allow" });
    await userEvent.click(screen.getByRole("button", { name: /open in terminal/i }));
    expect(fns.onOpenTerminal).toHaveBeenCalledWith("devops@hrns");
    await userEvent.click(screen.getByRole("button", { name: /cancel task/i }));
    expect(fns.onCancel).toHaveBeenCalledWith("devops@hrns");
  });
  it("done state shows outcome and Ack", async () => {
    render(<SidePanel agent={{ ...agent, state: "done" }} role={role} assignment={{ ...asg, state: "done", pending: null, outcome: "Rolled out.\nHealth green." }} {...fns} />);
    expect(screen.getByText(/Health green/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /ack/i }));
    expect(fns.onAck).toHaveBeenCalledWith("devops@hrns");
  });
  it("empty selection shows a hint", () => {
    render(<SidePanel agent={null} role={undefined} assignment={null} {...fns} />);
    expect(screen.getByText(/select an agent/i)).toBeInTheDocument();
  });
});
