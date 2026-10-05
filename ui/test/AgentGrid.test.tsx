import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentGrid } from "../src/components/AgentGrid";
import type { Agent, SessionInfo } from "../src/types";

const ag = (id: string, state: Agent["state"]): Agent => ({ id, role: "coder", repo: "/r/x", displayName: id, createdAt: id, state, currentAssignmentId: null });
const base = { roles: [], assignments: {}, selectedId: null, recentFor: () => [], onSelect: vi.fn(), onAssign: vi.fn() };

describe("AgentGrid", () => {
  it("titles each section with its count and explanation", () => {
    render(<AgentGrid {...base} agents={[ag("a", "working"), ag("b", "working")]} />);
    const sec = screen.getByTestId("section-working");
    expect(within(sec).getByRole("heading")).toHaveTextContent(/Working\s*2/);
    expect(sec).toHaveTextContent("Running now. You don't need to watch them.");
  });

  it("explains running-elsewhere sessions", () => {
    const live: SessionInfo = { sessionId: "s1", cwd: "/w/api", title: "zsh", kind: "interactive", status: "busy", at: Date.now() } as SessionInfo;
    render(<AgentGrid {...base} agents={[]} liveSessions={[live]} />);
    const sec = screen.getByTestId("section-live");
    expect(within(sec).getByRole("heading")).toHaveTextContent(/Running elsewhere\s*1/);
    expect(sec).toHaveTextContent("Claude Code sessions open outside AgentGrid. Pull one in to manage it here.");
  });
});
