import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugPanel } from "../src/components/BugPanel";
import type { BugTask } from "../src/types";

/** Stand-in for api.ts's real ApiError — same shape (message + status), so `instanceof` checks
 * inside BugPanel work against this mocked module exactly as they would against the real one.
 * Built via vi.hoisted so it's initialised before the hoisted vi.mock factory below runs. */
const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return { ApiError };
});

const bugPlan = vi.fn(async () => ({ markdown: "# Root cause\nThe token is rotated twice." }));
const bugDiff = vi.fn(async () => ({ patch: "diff --git a/x b/x\n+added line\n", additions: 3, deletions: 1,
  files: [{ path: "src/auth/session.ts", additions: 2, deletions: 1 }, { path: "test/session.test.ts", additions: 1, deletions: 0 }] }));
const approveBug = vi.fn(async (_id: string) => task("implementing"));
const requestBugChanges = vi.fn(async (_id: string, _text: string) => task("analyzing"));
const cancelBug = vi.fn(async (_id: string) => task("cancelled"));
const retryBug = vi.fn(async (_id: string) => task("implementing"));
const listBugTasks = vi.fn(async (): Promise<BugTask[]> => []);
vi.mock("../src/api", () => ({
  ApiError,
  api: {
    bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
    approveBug: (id: string) => approveBug(id), requestBugChanges: (id: string, t: string) => requestBugChanges(id, t),
    cancelBug: (id: string) => cancelBug(id), retryBug: (id: string) => retryBug(id),
    listBugTasks: () => listBugTasks(),
  },
}));

function task(stage: string, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@r",
    stage: stage as BugTask["stage"], gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0.4, history: [], error: null, createdAt: "", updatedAt: "", ...extra } as BugTask;
}

// A patch whose headers genuinely name both files in `files[]`, so hunksFor can isolate either.
const isolatedPatch = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index 111..222 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -1,2 +1,3 @@",
  "-old session line",
  "+new session line",
  "diff --git a/test/session.test.ts b/test/session.test.ts",
  "index 333..444 100644",
  "--- a/test/session.test.ts",
  "+++ b/test/session.test.ts",
  "@@ -1,1 +1,2 @@",
  "+new test line",
].join("\n") + "\n";

// I1: two paths where one is a genuine suffix of the other — everyday in a monorepo (this repo
// has three package.json files). A substring match on the `diff --git` header picks the wrong
// section for the shorter path AND calls it isolated, so file B's hunks show under file A's name.
const suffixCollisionPatch = [
  "diff --git a/ui/package.json b/ui/package.json",
  "index 111..222 100644",
  "--- a/ui/package.json",
  "+++ b/ui/package.json",
  "@@ -1,1 +1,2 @@",
  "+ui package line",
  "diff --git a/package.json b/package.json",
  "index 333..444 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1,1 +1,2 @@",
  "+root package line",
].join("\n") + "\n";

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

  it("Approve & implement is disabled while the plan is still loading", async () => {
    bugPlan.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & implement" })).toBeDisabled();
  });

  it("Approve & implement is disabled after the plan fails to load", async () => {
    bugPlan.mockImplementationOnce(async () => { throw new Error("plan fetch blew up"); });
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/plan fetch blew up/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Approve & implement" })).toBeDisabled();
  });

  it("surfaces a 501 as the bugfix workflow not being wired up yet", async () => {
    bugPlan.mockImplementationOnce(async () => { throw new ApiError("no route", 501); });
    render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/bug-fix workflow isn't enabled on this server yet/)).toBeInTheDocument());
  });

  it("diff gate falls back to the full patch and says so when a file's hunks can't be isolated", async () => {
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("src/auth/session.ts")).toBeInTheDocument());
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("2 files");
    expect(screen.getByTestId("diff-summary")).toHaveTextContent("+3");
    await userEvent.click(screen.getByRole("button", { name: /src\/auth\/session\.ts/ }));
    expect(screen.getByText(/\+added line/)).toBeInTheDocument();
    expect(screen.getByText(/could not isolate this file's hunks/i)).toBeInTheDocument();
  });

  it("diff gate isolates each file's own hunks and creates the PR", async () => {
    bugDiff.mockImplementationOnce(async () => ({
      patch: isolatedPatch, additions: 3, deletions: 1,
      files: [{ path: "src/auth/session.ts", additions: 2, deletions: 1 }, { path: "test/session.test.ts", additions: 1, deletions: 0 }],
    }));
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("src/auth/session.ts")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /src\/auth\/session\.ts/ }));
    expect(screen.getByText(/new session line/)).toBeInTheDocument();
    expect(screen.queryByText(/new test line/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not isolate/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /src\/auth\/session\.ts/ })); // collapse it
    await userEvent.click(screen.getByRole("button", { name: /test\/session\.test\.ts/ }));
    expect(screen.getByText(/new test line/)).toBeInTheDocument();
    expect(screen.queryByText(/new session line/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
  });

  it("Create PR is disabled while the diff is still loading", async () => {
    bugDiff.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
  });

  it("Create PR is disabled after the diff fails to load", async () => {
    bugDiff.mockImplementationOnce(async () => { throw new Error("diff fetch blew up"); });
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/diff fetch blew up/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
  });

  it("switching to a different task mid-fetch never shows the old task's content", async () => {
    let resolveA!: (v: { markdown: string }) => void;
    bugPlan.mockImplementationOnce(() => new Promise(res => { resolveA = res; }));
    bugPlan.mockImplementationOnce(async () => ({ markdown: "# Unrelated\nA totally different root cause." }));

    const taskA = task("plan-review", { id: "bt1" });
    const taskB = task("plan-review", { id: "bt2", issue: { ...taskA.issue, key: "PAY-99", title: "A different ticket" } });

    const { rerender } = render(<BugPanel task={taskA} onChanged={vi.fn()} />);
    rerender(<BugPanel task={taskB} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Unrelated/)).toBeInTheDocument());

    // Task A's fetch resolves late; its stale effect must be a no-op by now.
    resolveA({ markdown: "# Root cause\nThe token is rotated twice." });
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText(/rotated twice/)).not.toBeInTheDocument();
    expect(screen.getByText(/Unrelated/)).toBeInTheDocument();
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
    render(<BugPanel task={task("monitoring", { pr: { number: 7, url: "https://gh/pr/7", state: "OPEN", reviewDecision: null, checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "abc1234", lastSeenEventAt: "" } })} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://gh/pr/7");
    expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
  });

  it("a 409 on approve that comes back older than the current props does not overwrite the view", async () => {
    const current = task("plan-review", { updatedAt: "2024-01-02T00:00:00.000Z" });
    const onChanged = vi.fn();
    approveBug.mockImplementationOnce(async () => { throw new ApiError("stale", 409); });
    listBugTasks.mockImplementationOnce(async () => [task("plan-review", { updatedAt: "2024-01-01T00:00:00.000Z" })]);
    render(<BugPanel task={current} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/rotated twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    await waitFor(() => expect(listBugTasks).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a 409 on approve that comes back newer than the current props replaces the view", async () => {
    const current = task("plan-review", { updatedAt: "2024-01-01T00:00:00.000Z" });
    const onChanged = vi.fn();
    approveBug.mockImplementationOnce(async () => { throw new ApiError("stale", 409); });
    const fresh = task("implementing", { updatedAt: "2024-01-02T00:00:00.000Z" });
    listBugTasks.mockImplementationOnce(async () => [fresh]);
    render(<BugPanel task={current} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByText(/rotated twice/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(fresh));
  });

  it("matches a file to its own diff section when another path is a suffix of it", async () => {
    bugDiff.mockImplementation(async () => ({
      patch: suffixCollisionPatch, additions: 2, deletions: 0,
      files: [{ path: "ui/package.json", additions: 1, deletions: 0 }, { path: "package.json", additions: 1, deletions: 0 }],
    }));
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("ui/package.json")).toBeInTheDocument());

    // The root package.json must show ITS own hunk, not ui/package.json's.
    await userEvent.click(screen.getByRole("button", { name: /^package\.json/ }));
    expect(screen.getByText(/root package line/)).toBeInTheDocument();
    expect(screen.queryByText(/ui package line/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not isolate/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^package\.json/ })); // collapse
    await userEvent.click(screen.getByRole("button", { name: /^ui\/package\.json/ }));
    expect(screen.getByText(/ui package line/)).toBeInTheDocument();
    expect(screen.queryByText(/root package line/)).not.toBeInTheDocument();
  });

  it("names the commit the diff gate pinned, and shows nothing when none was recorded", async () => {
    const { unmount } = render(<BugPanel task={task("diff-review", { approvedHead: "1234567890abcdef1234567890abcdef12345678" })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diff-commit")).toHaveTextContent("1234567"));
    expect(screen.getByTestId("diff-commit")).not.toHaveTextContent("1234567890abcdef");
    unmount();
    render(<BugPanel task={task("diff-review")} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diff-summary")).toBeInTheDocument());
    expect(screen.queryByTestId("diff-commit")).not.toBeInTheDocument();
  });
});

