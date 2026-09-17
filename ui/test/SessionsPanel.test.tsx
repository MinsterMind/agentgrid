import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionsPanel } from "../src/components/SessionsPanel";
import type { RoleDef, SessionInfo } from "../src/types";

const sessions: SessionInfo[] = [
  { sessionId: "s-busy", cwd: "/w/hrns", title: "hrns-7e", kind: "interactive", status: "busy", at: Date.now() - 60_000, canAdopt: false },
  { sessionId: "s-bg", cwd: "/w/manoj", title: "Portfolio analysis", kind: "background", status: "blocked", at: Date.now() - 3_600_000, bgId: "d85e", canAdopt: false },
  { sessionId: "s-old", cwd: "/w/payments", title: "Idempotency keys", kind: "history", status: "ended", at: Date.now() - 7_200_000, canAdopt: true },
  { sessionId: "s-mine", cwd: "/w/hrns", title: "grid run", kind: "history", status: "ended", at: Date.now() - 9_000_000, agentId: "coder@hrns", canAdopt: false },
];
const listSessions = vi.fn(async () => sessions);
const adoptSession = vi.fn(async (id: string, input: { role: string }) => ({ id: `${input.role}@payments`, resumeSessionId: id }));
const attachSession = vi.fn(async (_id: string) => ({ command: "claude attach d85e", opened: true }));
vi.mock("../src/api", () => ({ api: { listSessions: () => listSessions(), adoptSession: (id: string, i: { role: string }) => adoptSession(id, i), attachSession: (id: string) => attachSession(id) } }));

const roles: RoleDef[] = [
  { name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" },
  { name: "reviewer", avatar: "🧐", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" },
];
const agentNames = { "coder@hrns": "Cody" };
beforeEach(() => vi.clearAllMocks());

describe("SessionsPanel", () => {
  it("groups live and recent sessions with status, repo and ownership", async () => {
    render(<SessionsPanel roles={roles} agentNames={agentNames} onAdopted={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("hrns-7e")).toBeInTheDocument());
    const live = screen.getByTestId("sessions-live");
    expect(live).toHaveTextContent("hrns-7e"); expect(live).toHaveTextContent("busy"); expect(live).toHaveTextContent("hrns");
    expect(live).toHaveTextContent("Portfolio analysis"); expect(live).toHaveTextContent("blocked");
    const recent = screen.getByTestId("sessions-recent");
    expect(recent).toHaveTextContent("Idempotency keys"); expect(recent).toHaveTextContent("payments");
    expect(recent).toHaveTextContent("on grid as Cody");
  });

  it("background sessions offer Attach in Terminal", async () => {
    render(<SessionsPanel roles={roles} agentNames={agentNames} onAdopted={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /attach in terminal/i }));
    expect(attachSession).toHaveBeenCalledWith("s-bg");
  });

  it("adopt: pick a role, creates the agent, reports it back", async () => {
    const onAdopted = vi.fn();
    render(<SessionsPanel roles={roles} agentNames={agentNames} onAdopted={onAdopted} onClose={vi.fn()} />);
    const row = (await screen.findByText("Idempotency keys")).closest("li")!;
    await userEvent.selectOptions(row.querySelector("select")!, "reviewer");
    await userEvent.click(screen.getByRole("button", { name: /adopt into grid/i }));
    expect(adoptSession).toHaveBeenCalledWith("s-old", { role: "reviewer" });
    await waitFor(() => expect(onAdopted).toHaveBeenCalledWith("reviewer@payments"));
  });

  it("only adoptable sessions get the adopt control", async () => {
    render(<SessionsPanel roles={roles} agentNames={agentNames} onAdopted={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText("hrns-7e");
    expect(screen.getAllByRole("button", { name: /adopt into grid/i })).toHaveLength(1);
  });
});
