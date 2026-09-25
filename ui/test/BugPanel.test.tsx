import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugPanel } from "../src/components/BugPanel";
import type { BugTask } from "../src/types";

const bugPlan = vi.fn(async () => ({ markdown: "# Root cause\nThe token is rotated twice." }));
const bugDiff = vi.fn(async () => ({ patch: "diff --git a/x b/x\n+added line\n", additions: 3, deletions: 1,
  files: [{ path: "src/auth/session.ts", additions: 2, deletions: 1 }, { path: "test/session.test.ts", additions: 1, deletions: 0 }] }));
const approveBug = vi.fn(async (_id: string) => task("implementing"));
const requestBugChanges = vi.fn(async (_id: string, _text: string) => task("analyzing"));
const cancelBug = vi.fn(async (_id: string) => task("cancelled"));
const retryBug = vi.fn(async (_id: string) => task("implementing"));
vi.mock("../src/api", () => ({ api: { bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
  approveBug: (id: string) => approveBug(id), requestBugChanges: (id: string, t: string) => requestBugChanges(id, t),
  cancelBug: (id: string) => cancelBug(id), retryBug: (id: string) => retryBug(id) } }));

function task(stage: string, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@r",
    stage: stage as BugTask["stage"], gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0.4, history: [], error: null, createdAt: "", updatedAt: "", ...extra } as BugTask;
}

beforeEach(() => vi.clearAllMocks());

describe("BugPanel", () => {
  it("always shows the ticket and the current stage", () => {
    render(<BugPanel task={task("implementing")} onChanged={vi.fn()} />);
    expect(screen.getByText("PAY-42")).toBeInTheDocument();
    expect(screen.getByText(/Refresh token rotates twice/)).toBeInTheDocument();
    expect(screen.getByTestId("bug-stage")).toHaveTextContent("implementing");
  });

  it("plan gate renders the plan and approves it", async () => {
    const onChanged = vi.fn();
    render(<BugPanel task={task("plan-review")} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/rotated twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("request changes sends the text and needs some", async () => {
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Request changes…" }));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("What should change"), "cover the retry path");
    await userEvent.click(send);
    expect(requestBugChanges).toHaveBeenCalledWith("bt1", "cover the retry path");
  });

  it("diff gate lists files with counts, expands hunks, and creates the PR", async () => {
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("src/auth/session.ts")).toBeInTheDocument());
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("2 files");
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("+3");
    await userEvent.click(screen.getByRole("button", { name: /src\/auth\/session\.ts/ }));
    expect(screen.getByText(/\+added line/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
  });

  it("failed tasks show the error with retry and cancel", async () => {
    render(<BugPanel task={task("failed", { error: "no commits on the task branch" })} onChanged={vi.fn()} />);
    expect(screen.getByText(/no commits on the task branch/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry stage" }));
    expect(retryBug).toHaveBeenCalledWith("bt1");
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(cancelBug).toHaveBeenCalledWith("bt1");
  });

  it("monitoring shows the PR link and no gate buttons", () => {
    render(<BugPanel task={task("monitoring", { pr: { number: 7, url: "https://gh/pr/7", state: "OPEN", reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", lastSeenEventAt: "" } })} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://gh/pr/7");
    expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
  });
});
