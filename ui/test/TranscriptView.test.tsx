import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranscriptView } from "../src/components/TranscriptView";
import type { Agent } from "../src/types";

const entries = [
  { ts: "2026-09-17T10:00:00Z", role: "user", kind: "text", text: "Fix the login bug" },
  { ts: "2026-09-17T10:00:05Z", role: "assistant", kind: "text", text: "Looking at src/auth first." },
  { ts: "2026-09-17T10:00:06Z", role: "assistant", kind: "tool_use", text: "Bash: npm test", tool: "Bash", input: { command: "npm test" } },
  { ts: "2026-09-17T10:00:09Z", role: "user", kind: "tool_result", text: "12 passed, 1 failed\nFAIL test/login.test.ts" },
  { ts: "2026-09-17T10:00:20Z", role: "assistant", kind: "text", text: "Fixed by rotating the refresh token." },
];
const agentTranscript = vi.fn(async (_id: string) => ({ sessionId: "sess-1234-abcd", entries }));
vi.mock("../src/api", () => ({ api: { agentTranscript: (id: string) => agentTranscript(id) } }));

const agent: Agent = { id: "coder@hrns", role: "coder", repo: "/w/hrns", displayName: "Cody", createdAt: "", state: "done", currentAssignmentId: "a1" };
beforeEach(() => vi.clearAllMocks());

describe("TranscriptView", () => {
  it("renders the whole conversation in order with roles, tool calls collapsed and results expandable", async () => {
    render(<TranscriptView agent={agent} activity="" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Fix the login bug")).toBeInTheDocument());
    const items = screen.getAllByTestId("tx-entry");
    expect(items.map(e => e.getAttribute("data-kind"))).toEqual(["text", "text", "tool_use", "tool_result", "text"]);
    expect(items[0]).toHaveAttribute("data-role", "user");
    expect(items[2]).toHaveTextContent("Bash");
    expect(items[2].querySelector("details")).not.toHaveAttribute("open");
    await userEvent.click(items[3].querySelector("summary")!);
    expect(items[3]).toHaveTextContent("FAIL test/login.test.ts");
    expect(screen.getByText(/session sess-123/)).toBeInTheDocument();
  });

  it("re-fetches when activity changes (live follow)", async () => {
    const { rerender } = render(<TranscriptView agent={{ ...agent, state: "working" }} activity="one" onClose={vi.fn()} />);
    await waitFor(() => expect(agentTranscript).toHaveBeenCalledTimes(1));
    rerender(<TranscriptView agent={{ ...agent, state: "working" }} activity="two" onClose={vi.fn()} />);
    await waitFor(() => expect(agentTranscript).toHaveBeenCalledTimes(2));
  });

  it("shows an empty state when the agent has no session yet", async () => {
    agentTranscript.mockResolvedValueOnce({ sessionId: null as unknown as string, entries: [] });
    render(<TranscriptView agent={{ ...agent, state: "free", currentAssignmentId: null }} activity="" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no session yet/i)).toBeInTheDocument());
  });
});
