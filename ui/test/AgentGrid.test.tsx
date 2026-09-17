import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentGrid } from "../src/components/AgentGrid";
import type { Agent, RoleDef, SessionInfo } from "../src/types";

const roles: RoleDef[] = [{ name: "coder", avatar: "👩‍💻", model: "m", effort: "high", permissionMode: "default", settingSources: [], allowedTools: [], maxTurns: 1, prompt: "" }];
const ag = (id: string, state: Agent["state"]): Agent => ({ id, role: "coder", repo: "/r/" + id, displayName: id, createdAt: id, state, currentAssignmentId: null });
const live = (id: string, at: number): SessionInfo => ({ sessionId: id, cwd: "/w/" + id, title: id, kind: "interactive", status: "idle", at, canAdopt: true });

describe("AgentGrid layout", () => {
  it("puts agent sections first and live sessions last, newest live first", () => {
    render(<AgentGrid agents={[ag("a", "free"), ag("b", "waiting")]} roles={roles} assignments={{}} selectedId={null} recentFor={() => []} onSelect={vi.fn()} onAssign={vi.fn()}
      liveSessions={[live("old", 1000), live("new", 3000), live("mid", 2000)]} onPullIn={async () => {}} />);
    const sections = screen.getAllByTestId(/^section-/).map(e => e.getAttribute("data-testid"));
    expect(sections).toEqual(["section-waiting", "section-free", "section-live"]);
    const liveIds = screen.getAllByTestId(/^session-/).map(e => e.getAttribute("data-testid"));
    expect(liveIds).toEqual(["session-new", "session-mid", "session-old"]);
  });
});
