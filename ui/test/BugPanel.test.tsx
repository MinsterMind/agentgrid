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
const approveBug = vi.fn(async (_id: string, _mergeMethod?: string) => task("implementing"));
const requestBugChanges = vi.fn(async (_id: string, _text: string) => task("analyzing"));
const cancelBug = vi.fn(async (_id: string) => task("cancelled"));
const retryBug = vi.fn(async (_id: string) => task("implementing"));
const listBugTasks = vi.fn(async (): Promise<BugTask[]> => []);
const addressComments = vi.fn(async (_id: string, _text?: string) => task("review-feedback"));
const dismissBug = vi.fn(async (_id: string) => undefined);
vi.mock("../src/api", () => ({
  ApiError,
  api: {
    bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
    approveBug: (id: string, mergeMethod?: string) => (mergeMethod ? approveBug(id, mergeMethod) : approveBug(id)), requestBugChanges: (id: string, t: string) => requestBugChanges(id, t),
    cancelBug: (id: string) => cancelBug(id), retryBug: (id: string) => retryBug(id),
    listBugTasks: () => listBugTasks(),
    addressComments: (id: string, text?: string) => addressComments(id, text),
    dismissBug: (id: string) => dismissBug(id),
  },
}));

function task(stage: string, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@r",
    stage: stage as BugTask["stage"], gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", pr: null, costUsd: 0.4, history: [], error: null, createdAt: "", updatedAt: "", ...extra } as BugTask;
}

function monitoring(extra: Partial<BugTask> = {}): BugTask {
  return task("monitoring", extra);
}

function atGate(stage: string, gate: { kind: string; openedAt: string; reason?: "feedback" | "rebase" }, extra: Partial<BugTask> = {}): BugTask {
  return task(stage, { gate: gate as BugTask["gate"], ...extra });
}

function done(extra: Partial<BugTask> = {}): BugTask {
  return task("done", { outcome: "merged", pr: { number: 9, url: "https://x/pr/9", state: "MERGED", reviewDecision: "APPROVED", checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "deadbee", lastSeenEventAt: "2026-09-26T10:00:00Z" }, ...extra });
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
    expect(screen.getByTestId("bug-stage")).toHaveTextContent("Implementing");
    expect(screen.getByTestId("bug-stage")).toHaveAttribute("data-stage", "implementing");
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
    expect(await screen.findByLabelText("Loading the plan")).toBeInTheDocument();
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
    expect(screen.getByText("added line")).toBeInTheDocument();
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

describe("the monitoring card", () => {
  it("shows the PR, its state chips and when it was last checked", () => {
    render(<BugPanel task={monitoring({ pr: { number: 7, url: "https://x/pr/7", state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE", mergeable: "MERGEABLE",
      headSha: "abc", lastSeenEventAt: "2026-09-26T09:00:00Z" } })} onChanged={() => {}} />);
    expect(screen.getByRole("link", { name: /#7/ })).toHaveAttribute("href", "https://x/pr/7");
    expect(screen.getByText(/changes requested/i)).toBeInTheDocument();
    expect(screen.getByText(/checks failing/i)).toBeInTheDocument();
  });

  it("offers a manual feedback round and says when the forge could not be read", async () => {
    const task = monitoring({ error: "could not check the pull request: gh: could not connect" });
    render(<BugPanel task={task} onChanged={() => {}} />);
    expect(screen.getByText(/could not check the pull request/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Ask the agent to address these/i }));
    expect(addressComments).toHaveBeenCalledWith("bt1", undefined);
  });

  // I1: the feedback-round cap writes its explanation into `task.error` and changes no stage, so
  // nothing notifies. If the card does not render it, the watcher has silently stopped working on
  // the task and the user is never told why — or what the way forward is.
  it("shows the feedback-round cap message, which is the only signal that dispatching stopped", () => {
    const cap = 'this task has hit 5 feedback rounds; AgentGrid has stopped dispatching after 5 feedback rounds — use "Ask the agent to address these" to continue';
    render(<BugPanel task={monitoring({ error: cap })} onChanged={() => {}} />);
    expect(screen.getByTestId("monitoring-error")).toHaveTextContent(/hit 5 feedback rounds/);
    // And the escape hatch it names is right there.
    expect(screen.getByRole("button", { name: /Ask the agent to address these/i })).toBeInTheDocument();
  });

  // I2: `pr.lastSeenEventAt` is the PR's own `updatedAt` from the forge. On a quiet PR it claims
  // hours ago while polling is perfectly healthy, and when the forge is unreachable it never
  // moves at all. "Last checked" must be a poll time.
  it("shows when the server last polled, not when the PR was last updated", () => {
    const t = monitoring({
      prCheckedAt: "2026-09-26T15:30:00Z",
      pr: { number: 7, url: "https://x/pr/7", state: "OPEN", reviewDecision: null, checks: "SUCCESS",
        mergeable: "MERGEABLE", headSha: "abc", lastSeenEventAt: "2026-09-26T09:00:00Z" },
    });
    render(<BugPanel task={t} onChanged={() => {}} />);
    const shown = screen.getByTestId("pr-last-checked").textContent ?? "";
    expect(shown).toContain(new Date("2026-09-26T15:30:00Z").toLocaleString());
    expect(shown).not.toContain(new Date("2026-09-26T09:00:00Z").toLocaleString());
  });

  it("says it has not polled yet rather than showing a PR timestamp as a poll time", () => {
    const t = monitoring({ prCheckedAt: null,
      pr: { number: 7, url: "https://x/pr/7", state: "OPEN", reviewDecision: null, checks: "SUCCESS",
        mergeable: "MERGEABLE", headSha: "abc", lastSeenEventAt: "2026-09-26T09:00:00Z" } });
    render(<BugPanel task={t} onChanged={() => {}} />);
    expect(screen.getByTestId("pr-last-checked")).toHaveTextContent(/not checked yet/i);
  });
});

describe("the labelled diff gate", () => {
  it("says what it is approving for a feedback round and for a rebase", () => {
    const fb = atGate("diff-review", { kind: "diff", openedAt: "t", reason: "feedback" });
    const { rerender } = render(<BugPanel task={fb} onChanged={() => {}} />);
    expect(screen.getByText(/reviewers asked for changes/i)).toBeInTheDocument();
    rerender(<BugPanel task={atGate("diff-review", { kind: "diff", openedAt: "t", reason: "rebase" })} onChanged={() => {}} />);
    expect(screen.getByText(/conflicts with/i)).toBeInTheDocument();
  });
});

describe("the merge gate", () => {
  it("merges with the shown method", async () => {
    render(<BugPanel task={atGate("approved", { kind: "merge", openedAt: "t" })} onChanged={() => {}} />);
    const select = screen.getByLabelText(/merge method/i);
    await userEvent.selectOptions(select, "merge");
    await userEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(approveBug).toHaveBeenCalledWith("bt1", "merge");
  });

  it("resets the selected merge method when the panel is repointed at a different task", async () => {
    // SidePanel keeps one BugPanel mounted across the whole sidebar's lifetime and just
    // re-renders it with a new `task` prop on selection change — no `key`, no remount — so
    // this simulates that exact case: the same mounted component, a different task's props.
    const taskA = atGate("approved", { kind: "merge", openedAt: "t" }, { id: "bt1", mergeMethod: "squash" });
    const taskB = atGate("approved", { kind: "merge", openedAt: "t" }, { id: "bt2", mergeMethod: "merge" });
    const { rerender } = render(<BugPanel task={taskA} onChanged={() => {}} />);
    expect(screen.getByLabelText(/merge method/i)).toHaveValue("squash");
    rerender(<BugPanel task={taskB} onChanged={() => {}} />);
    expect(screen.getByLabelText(/merge method/i)).toHaveValue("merge");
    await userEvent.click(screen.getByRole("button", { name: /^Merge/ }));
    expect(approveBug).toHaveBeenCalledWith("bt2", "merge");
  });
});

describe("the done card", () => {
  it("shows the merged PR and dismisses", async () => {
    const onChanged = vi.fn();
    render(<BugPanel task={done()} onChanged={onChanged} />);
    expect(screen.getByText(/merged/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(dismissBug).toHaveBeenCalledWith("bt1");
  });

  it("shows what cleanup left behind, each command on its own element, and stays a merged outcome", () => {
    const { container } = render(<BugPanel task={done({ error: "worktree cleanup incomplete: …\n  git -C /r worktree remove --force /r/.worktrees/bugfix-W-1\n  git -C /r branch -D bugfix/PAY-42" })} onChanged={() => {}} />);
    // The heading must stay "Merged" — this fixture's `pr.state` is "MERGED" (from `done()`),
    // and the error text deliberately does NOT match the old literal ("the pull request was
    // closed without merging"), so this would fail if the classification ever went back to
    // matching prose instead of `pr.state`.
    expect(screen.getByText("Merged")).toBeInTheDocument();
    // Each command in the cleanup message must be its own element with its own Copy — not one
    // collapsed text node, which `getByText`/`getNodeText` would match either way.
    expect(screen.getByRole("alert")).toHaveTextContent("worktree cleanup incomplete");
    const cmds = Array.from(container.querySelectorAll(".errcard code.cmd"));
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toHaveTextContent(/^git -C \/r worktree remove --force/);
    expect(cmds[1]).toHaveTextContent(/^git -C \/r branch -D/);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
  });

  // The durable outcome is the discriminator (C3). Both proxies it replaced could be wrong in a
  // way the user would act on: a stale watcher tick can overwrite `pr.state` after a real merge,
  // and matching the error's wording reclassifies on a copy edit.
  it("calls a merge a merge even when the PR view was left stale by a racing poll", () => {
    render(<BugPanel task={done({ outcome: "merged", pr: { number: 9, url: "https://x/pr/9", state: "OPEN", reviewDecision: "APPROVED", checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "deadbee", lastSeenEventAt: "2026-09-26T10:00:00Z" } })} onChanged={() => {}} />);
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.queryByText("Closed without merging")).not.toBeInTheDocument();
  });

  it("shows a PR closed without merging as not-a-success by the recorded outcome, whatever the PR view or the error wording says", () => {
    render(<BugPanel task={done({ outcome: "closed", pr: { number: 9, url: "https://x/pr/9", state: "MERGED", reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "2026-09-26T10:00:00Z" }, error: "closed without a merge, per the forge" })} onChanged={() => {}} />);
    expect(screen.getByText("Closed without merging")).toBeInTheDocument();
    expect(screen.getByText(/closed without a merge, per the forge/)).toBeInTheDocument();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
  });

  it("offers a transcript link when the host provides one", async () => {
    const onTranscript = vi.fn();
    render(<BugPanel task={done()} onChanged={() => {}} onTranscript={onTranscript} />);
    await userEvent.click(screen.getByRole("button", { name: /Transcript/i }));
    expect(onTranscript).toHaveBeenCalledWith("bugfix@r");
  });
  it("renders the plan as sections, not markdown source", async () => {
    bugPlan.mockResolvedValueOnce({ markdown: "## Root cause\nThe **token** rotates.\n\n## Fix\nOnce." });
    const { container } = render(<BugPanel task={task("plan-review")} onChanged={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Root cause" })).toBeInTheDocument();
    expect(container.querySelector(".planmd")).toBeNull();
    expect(container.textContent).not.toContain("**");
  });

  it("shows a failed stage as an error card", () => {
    render(<BugPanel task={task("failed", { error: "no commits on the task branch. Check the worktree." })} onChanged={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no commits on the task branch.");
  });

  it("links to the full view", () => {
    render(<BugPanel task={task("implementing")} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: /open full view/i })).toHaveAttribute("href", "#/bugs/bt1");
  });
});

