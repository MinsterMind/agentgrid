import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugScreen, mergeRows } from "../src/components/BugScreen";
import { api } from "../src/api";
import type { BugTask } from "../src/types";

const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  }
  return { ApiError };
});

const SETUP = { ready: true, wired: true, addCommand: "", discovery: { servers: [], problems: [] }, checks: [] };
const getSetup = vi.fn(async (): Promise<unknown> => SETUP);
const bugPlan = vi.fn(async () => ({ markdown: "## Root cause\nA\n\n## Fix\nB" }));
const bugDiff = vi.fn(async () => ({ patch: "", files: [], additions: 0, deletions: 0 }));
const approveBug = vi.fn(async (_id: string, _m?: string) => task("implementing"));
const resolveConflicts = vi.fn(async () => ({ ids: ["bt1", "bt2"] }));
type Issue = { key: string; title: string; url: string; status: string; priority: string };
/** The list as the server's tracker cache answers it. */
const L = (issues: Issue[], over: Record<string, unknown> = {}) => ({ issues, fetchedAt: new Date(Date.now() - 2 * 60_000).toISOString() as string | null, refreshing: false, error: null as string | null, generation: 0, ...over });
const myIssues = vi.fn(async (): Promise<ReturnType<typeof L>> => L([]));
const refreshIssues = vi.fn(async () => ({}));
const bugPreflight = vi.fn(async () => ({ ok: true, problems: [], baseBranch: "main", branches: ["main"] }));
vi.mock("../src/api", () => ({
  ApiError,
  api: {
    getSetup: () => getSetup(), bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
    approveBug: (id: string, m?: string) => (m ? approveBug(id, m) : approveBug(id)),
    requestBugChanges: vi.fn(), cancelBug: vi.fn(), retryBug: vi.fn(), listBugTasks: vi.fn(async () => []),
    addressComments: vi.fn(), dismissBug: vi.fn(),
    myIssues: () => myIssues(), refreshIssues: () => refreshIssues(), issue: vi.fn(async () => ({ key: "PAY-1", title: "Not started", url: "u", status: "Open", priority: "High", description: "", acceptanceCriteria: [] })),
    getIntegrations: vi.fn(async () => ({ projectRepos: {} })), resolveConflicts: () => resolveConflicts(), bugPreflight: () => bugPreflight(), createBugTask: vi.fn(), pickFolder: vi.fn(), startBatch: vi.fn(async () => ({ batchId: "b1" })), startImport: vi.fn(async () => ({ importId: "i1" })), spend: vi.fn(async () => ({ today: 0, limit: null })),
  },
}));

const ISSUE = { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] as string[] };
function task(stage: BugTask["stage"], extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: ISSUE, trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", baseRef: "origin/main", ticketCommits: [], verdict: null, report: null, plannedTests: [], testsInDiff: null, testOverride: null, conflict: null, conflictCheckError: null, queuedAt: null, queuedNote: null, trackerSyncError: null, queuedReason: null, commentsSince: null, commentsPendingSince: null, commentsNote: null, imported: false, leaseHead: null, runs: [], stageModel: {}, agentId: "bugfix@r",
    stage, gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : stage === "approved" ? { kind: "merge", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", approvedHead: null, outcome: null, checksRoundHead: null, pr: null, prCheckedAt: null,
    costUsd: 0.4, history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage, at: "2026-10-05T10:05:00Z", note: "" }], error: null,
    createdAt: "", updatedAt: "2026-10-05T10:05:00Z", feedbackRounds: 0, assumptions: [], assumptionsProblem: null, assumptionsToken: null, ...extra };
}

beforeEach(() => { vi.clearAllMocks(); getSetup.mockImplementation(async () => SETUP); myIssues.mockImplementation(async () => L([])); });

import { initial } from "../src/state/reducer";

const stateWith = (tasks: BugTask[]) => ({ ...initial, loaded: true, bugTasks: Object.fromEntries(tasks.map(t => [t.id, t])) });
const renderScreen = (tasks: BugTask[], selectedId: string | null = tasks[0]?.id ?? null, extra = {}) => {
  const onSelect = vi.fn();
  render(<BugScreen state={stateWith(tasks) as never} selectedId={selectedId} onSelect={onSelect} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} {...extra} />);
  return { onSelect };
};

describe("BugScreen", () => {
  it("shows today's bug-fix spend against the limit, and the cost per step", async () => {
    vi.mocked(api.spend).mockResolvedValue({ today: 4.2, limit: 20 });
    renderScreen([task("diff-review", { runs: [{ stage: "analyzing", model: "claude-opus-5", costUsd: 1.1, at: "a", ok: true }] })]);
    expect(await screen.findByText("Today $4.20 of $20.00")).toBeTruthy();
    expect(screen.getByText(/Plan.*Opus.*\$1\.10|Analy.*Opus.*\$1\.10/)).toBeTruthy();
  });
  it("with no limit, just today's spend; a held task says so in the list", async () => {
    vi.mocked(api.spend).mockResolvedValue({ today: 4.2, limit: null });
    renderScreen([task("analyzing", { queuedAt: "2026-10-09T10:00:00Z", queuedReason: "Daily limit reached ($20.00 of $20.00)" })]);
    expect(await screen.findByText("Today $4.20")).toBeTruthy();
    expect(screen.getByText(/Held · daily limit/)).toBeTruthy();
  });
  it("opens Import tickets from the list header", async () => {
    renderScreen([task("implementing")]);
    await userEvent.click(screen.getByRole("button", { name: "Import tickets…" }));
    expect(screen.getByTestId("import-tickets")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("import-tickets")).toBeNull();
  });
  it("lists every bug with a status word, active ones first", () => {
    renderScreen([task("done", { id: "bt1", issue: { ...ISSUE, key: "PAY-1" } }), task("plan-review", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt2");
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent("PAY-2"); expect(rows[0]).toHaveTextContent(/waiting on you/i);
    expect(rows[1]).toHaveTextContent("PAY-1"); expect(rows[1]).toHaveTextContent(/done/i);
  });

  it("shows the pipeline with the current step marked in words", () => {
    renderScreen([task("implementing")]);
    const strip = screen.getByRole("list", { name: /pipeline/i });
    expect(within(strip).getByText("Implement").closest("li")).toHaveAttribute("data-state", "current");
    expect(within(strip).getAllByText(/^done$/i).length).toBeGreaterThan(0);
  });

  it("says nothing is blocking when nothing is", () => {
    renderScreen([task("implementing")]);
    expect(screen.getByText("Nothing is blocking this bug.")).toBeInTheDocument();
  });

  it("puts an open gate first in Blocking", () => {
    renderScreen([task("plan-review")]);
    expect(screen.getByRole("region", { name: /blocking/i })).toHaveTextContent("Waiting on you: approve the plan");
  });

  it("lists assumptions questions-first, tagged by stage, new ones marked, with the problem line", () => {
    renderScreen([task("plan-review", { assumptionsProblem: "The analyzing stage's assumptions file is not valid JSON.", assumptions: [
      { id: "a:0", stage: "analyzing", round: 0, kind: "assumption", text: "Rounding is **only** at checkout", at: "t" },
      { id: "a:1", stage: "analyzing", round: 0, kind: "question", text: "Up or down?", at: "t" },
    ] })]);
    const region = screen.getByRole("region", { name: /assumptions/i });
    const items = within(region).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Up or down?");
    expect(items[1]).toHaveTextContent(/Analyzing/);
    expect(items[0]).toHaveTextContent(/new/i);
    expect(region.querySelector("strong")!.textContent).toBe("only");
    expect(region).toHaveTextContent(/not valid JSON/);
  });

  it("renders the ticket description as markdown", async () => {
    const { container } = render(<BugScreen state={stateWith([task("implementing", { issue: { ...ISSUE, description: "Steps:\n1. **Open** it" } })]) as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    await userEvent.click(container.querySelector(".section-collapse summary") as HTMLElement);   // the section, not the header's Ticket link
    expect(container.querySelector(".section-collapse strong")!.textContent).toBe("Open");
  });

  it("has an empty state for assumptions", () => {
    renderScreen([task("analyzing")]);
    expect(screen.getByText("The agent has not reported any assumptions yet.")).toBeInTheDocument();
  });

  it("shows the timeline newest first with readable stage names", () => {
    renderScreen([task("plan-review", { history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage: "analyzing", at: "2026-10-05T10:01:00Z", note: "" }, { stage: "plan-review", at: "2026-10-05T10:05:00Z", note: "Plan written" }] })]);
    const items = within(screen.getByRole("region", { name: /timeline/i })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Plan review"); expect(items[0]).toHaveTextContent("Plan written");
    expect(items[2]).toHaveTextContent("Setting up");
    expect(screen.queryByText("plan-review")).toBeNull();
  });

  it("approves from the screen through the same API the side panel uses", async () => {
    renderScreen([task("plan-review")]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve & implement" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Approve & implement" }));
    expect(approveBug).toHaveBeenCalledWith("bt1");
  });

  it("moves through the list with the arrow keys", async () => {
    const { onSelect } = renderScreen([task("implementing", { id: "bt1" }), task("analyzing", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt1");
    screen.getAllByRole("option")[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenCalledWith("bt2");
  });

  // Review Focus 4.
  it("falls back to the first bug when the selected one no longer exists", () => {
    const { onSelect } = renderScreen([task("implementing", { id: "bt1" })], "bt9");
    expect(onSelect).toHaveBeenCalledWith("bt1", { replace: true });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("PAY-42");
  });

  it("has an empty state that explains the screen and starts a fix", () => {
    const onFixBug = vi.fn();
    render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={onFixBug} />);
    expect(screen.getByText(/No bug fixes yet/)).toBeInTheDocument();
    expect(screen.getByText(/You approve the plan, the diff and the merge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fix a bug" })).toBeInTheDocument();
  });

  it("says when setup could not be checked", async () => {
    getSetup.mockRejectedValueOnce(new Error("down"));
    renderScreen([task("implementing")]);
    expect(await screen.findByText("Could not check setup")).toBeInTheDocument();
  });
describe("BugScreen polish", () => {
  it("shows a failed stage's error once, with Blocking pointing at it", () => {
    renderScreen([task("failed", { error: "no commits on the task branch", history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] })]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("region", { name: /blocking/i })).toHaveTextContent("The Implementing stage failed");
  });
  it("reads elapsed time as a duration while a stage runs", () => {
    renderScreen([task("implementing")]);
    expect(screen.getByRole("region", { name: /now/i })).toHaveTextContent(/for \d/);
  });
});
});

describe("BugScreen — the list", () => {
  it("shows each row's status in words with the stage it is at", () => {
    renderScreen([task("plan-review"), task("implementing", { id: "bt2", issue: { ...ISSUE, key: "PAY-2" } })], "bt1");
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent(/Waiting on you · Plan review/);
    expect(rows[1]).toHaveTextContent(/Running · Implementing/);
    expect(rows[0]).toHaveAttribute("data-status", "waiting");
  });

  it("uses icons, not glyphs, for status", () => {
    renderScreen([task("failed"), task("done", { id: "bt2" })], "bt1");
    for (const row of screen.getAllByRole("option")) expect(row.textContent).not.toMatch(/[⚠✗✓●○–]/);
    expect(screen.getAllByRole("option")[0].querySelector("svg")).not.toBeNull();
  });

  // Review Focus 1
  it("keeps the full title on hover for a long one", () => {
    const long = "A".repeat(140);
    renderScreen([task("implementing", { issue: { ...ISSUE, title: long } })]);
    expect(screen.getAllByRole("option")[0].querySelector(".t")).toHaveAttribute("title", long);
  });

  it("heads the list with its count", () => {
    renderScreen([task("implementing"), task("done", { id: "bt2" })], "bt1");
    expect(screen.getByRole("listbox").closest(".buglist")!.querySelector(".lh")).toHaveTextContent(/My bugs\s*2/);
  });
});

describe("BugScreen — header", () => {
  it("shows cost and review rounds as counters, and the agent by name", () => {
    const state = { ...stateWith([task("monitoring", { costUsd: 0.84, feedbackRounds: 2 })]),
      agents: [{ id: "bugfix@r", role: "bugfix", repo: "/r", displayName: "Kai", createdAt: "", state: "free", currentAssignmentId: null }] };
    render(<BugScreen state={state as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    const head = document.querySelector(".dhead")!;
    expect(within(head as HTMLElement).getByText("Cost").closest(".counter")).toHaveTextContent("$0.84");
    expect(within(head as HTMLElement).getByText("Review rounds").closest(".counter")).toHaveTextContent("2");
    expect(head).toHaveTextContent("Bug fixer · Kai");
    expect(within(head as HTMLElement).getByRole("link", { name: /ticket/i })).toHaveAttribute("href", "https://x/PAY-42");
  });
});

describe("BugScreen — pipeline", () => {
  it("is a connected stepper: dot, name and word per step", () => {
    renderScreen([task("plan-review")]);
    const strip = screen.getByRole("list", { name: "Pipeline" });
    const step = within(strip).getByText("Plan review").closest("li")!;
    expect(step).toHaveAttribute("data-state", "waiting");
    expect(step.querySelector(".pdot svg")).not.toBeNull();
    expect(step.querySelector(".pword")).toHaveTextContent("waiting on you");
    expect(strip.textContent).not.toMatch(/[⚠✗✓●○]/);
  });

  // Review Focus 2
  it("stops at a failed step: red word there, nothing reached after it", () => {
    renderScreen([task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] })]);
    const strip = screen.getByRole("list", { name: "Pipeline" });
    expect(within(strip).getByText("Implement").closest("li")).toHaveAttribute("data-state", "failed");
    expect(within(strip).getByText("Diff review").closest("li")).toHaveAttribute("data-state", "todo");
  });
});

describe("BugScreen — panels", () => {
  it("puts Blocking beside Now, and only glows Blocking when something blocks", () => {
    renderScreen([task("plan-review")]);
    const blocking = screen.getByRole("region", { name: /blocking/i });
    expect(blocking).toHaveClass("panel"); expect(blocking).toHaveClass("has");
    expect(blocking.parentElement).toBe(screen.getByRole("region", { name: /now/i }).parentElement);
    expect(blocking.parentElement).toHaveClass("row2");
    cleanup();
    // Review Focus 3
    renderScreen([task("implementing")]);
    expect(screen.getByRole("region", { name: /blocking/i })).not.toHaveClass("has");
  });

  it("colours timeline dots by what each entry was", () => {
    renderScreen([task("plan-review", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "analyzing", at: "b", note: "" }, { stage: "plan-review", at: "c", note: "" }] })]);
    const items = within(screen.getByRole("region", { name: /timeline/i })).getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-tone", "waiting");
    expect(items[1]).toHaveAttribute("data-tone", "done");
  });

describe("BugScreen — review fixes", () => {
  // M1: a finished bug's newest timeline entry keeps its own colour even if its agent is busy elsewhere.
  it("a failed bug's newest timeline entry is red even while its agent waits on other work", () => {
    const agentRec = { id: "bugfix@r", role: "bugfix", repo: "/r", displayName: "Kai", createdAt: "", state: "waiting", currentAssignmentId: "a9" };
    const asg = { id: "a9", agentId: "bugfix@r", prompt: "other", createdAt: "", startedAt: null, endedAt: null, sessionId: null, state: "waiting",
      activity: "", pending: { kind: "permission", toolUseId: "t", toolName: "Bash", input: {}, suggestions: [] }, outcome: null, error: null, turns: 0, costUsd: 0 };
    const t = task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] });
    const state = { ...stateWith([t]), agents: [agentRec], assignments: { a9: asg } };
    render(<BugScreen state={state as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    expect(within(screen.getByRole("region", { name: /timeline/i })).getAllByRole("listitem")[0]).toHaveAttribute("data-tone", "failed");
  });

  // M5
  it("shows the full worktree path on hover", () => {
    renderScreen([task("implementing")]);
    expect(document.querySelector(".dhead .path")).toHaveAttribute("title", "/w");
  });
});

});

describe("BugScreen — answering the agent", () => {
  it("shows the bug agent's permission request in Now, and answers it there", async () => {
    const onDecide = vi.fn();
    const state = { ...stateWith([task("implementing")]),
      agents: [{ id: "bugfix@r", role: "bugfix", repo: "/w", displayName: "PAY-42", createdAt: "", state: "free", currentAssignmentId: null }],
      permissions: { pr7: { id: "pr7", agentId: "bugfix@r", source: "terminal" as const, sessionId: "s", toolName: "Bash", input: { command: "gh pr comment 7" }, suggestedRule: "Bash(gh pr:*)", ruleIsBroad: false, createdAt: "" } } };
    render(<BugScreen state={state as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} onDecide={onDecide} />);
    const now = screen.getByRole("region", { name: "Now" });
    expect(within(now).getByTestId("pending-permission")).toHaveTextContent("gh pr comment 7");
    await userEvent.click(within(now).getByRole("button", { name: /^allow$/i }));
    expect(onDecide).toHaveBeenCalledWith("bugfix@r", "pr7", { kind: "allow" });
  });
  it("an SDK run's pending request is answered there too", async () => {
    const onDecide = vi.fn();
    const state = { ...stateWith([task("implementing")]),
      agents: [{ id: "bugfix@r", role: "bugfix", repo: "/w", displayName: "PAY-42", createdAt: "", state: "waiting", currentAssignmentId: "a1" }],
      assignments: { a1: { id: "a1", agentId: "bugfix@r", prompt: "p", createdAt: "", startedAt: null, endedAt: null, sessionId: "s", state: "waiting", activity: "", outcome: null, error: null, turns: 0, costUsd: 0,
        pending: { kind: "permission", toolUseId: "tu1", toolName: "Bash", input: { command: "npm test" }, suggestions: [], suggestedRule: "Bash(npm test:*)", ruleIsBroad: false } } } };
    render(<BugScreen state={state as never} selectedId="bt1" onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} onDecide={onDecide} />);
    await userEvent.click(within(screen.getByRole("region", { name: "Now" })).getByRole("button", { name: "Always allow Bash(npm test:*)" }));
    expect(onDecide).toHaveBeenCalledWith("bugfix@r", "tu1", { kind: "always" });
  });
});

describe("BugScreen — every bug assigned to me", () => {
  const MINE = [{ key: "PAY-1", title: "Not started", url: "u", status: "Open", priority: "High" }, { key: "PAY-42", title: "Refresh token rotates twice", url: "u", status: "Open", priority: "Low" }];
  const keys = () => screen.getAllByRole("option").map(r => r.querySelector(".k")!.textContent);
  it("lists every open bug assigned to me, started or not — active work first", async () => {
    myIssues.mockResolvedValue(L(MINE));
    renderScreen([task("implementing")]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(keys()).toEqual(["PAY-42", "PAY-1"]);
    const unstarted = screen.getAllByRole("option")[1];
    expect(unstarted).toHaveTextContent("Not started"); expect(unstarted).toHaveTextContent("High");
  });
  it("a started task whose ticket left my list sits in its own group, last", async () => {
    myIssues.mockResolvedValue(L([MINE[0]]));
    renderScreen([task("monitoring", { id: "bt9", issue: { ...ISSUE, key: "PAY-9", title: "Old one" } })], "bt9");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(keys()).toEqual(["PAY-1", "PAY-9"]);
    expect(screen.getByText("Not assigned to you or closed")).toBeInTheDocument();
  });
  // Review Focus 5
  it("with the tracker down, started tasks still show, with the error and a Refresh", async () => {
    myIssues.mockRejectedValue(new Error("tracker unavailable"));
    renderScreen([task("monitoring")]);
    expect(await screen.findByText(/tracker unavailable/)).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    myIssues.mockResolvedValue(L(MINE));
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.queryByText(/tracker unavailable/)).toBeNull();
  });
  it("clicking an unstarted bug routes to its ticket", async () => {
    myIssues.mockResolvedValue(L(MINE));
    const onSelectTicket = vi.fn();
    renderScreen([task("implementing")], "bt1", { onSelectTicket });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("option")[1]);
    expect(onSelectTicket).toHaveBeenCalledWith("PAY-1");
  });
  it("a selected ticket shows its details instead of a task", async () => {
    myIssues.mockResolvedValue(L(MINE));
    renderScreen([task("implementing")], null, { selectedTicket: "PAY-1", onSelectTicket: vi.fn() });
    expect(await screen.findByTestId("ticket-detail")).toBeInTheDocument();
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });
  it("the empty state shows only when there are no tasks and no assigned bugs", async () => {
    myIssues.mockResolvedValue(L([MINE[0]]));
    renderScreen([]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.queryByText("No bug fixes yet")).toBeNull();
  });
});

describe("mergeRows", () => {
  it("keeps every task: a second task for the same ticket gets its own row", () => {
    const active = task("implementing", { id: "bt3" }); const old = task("cancelled", { id: "bt1" });
    const rows = mergeRows([{ key: "PAY-42", title: "x", url: "u", status: "Open", priority: "High" }], [{ t: active, status: "running" }, { t: old, status: "cancelled" }]);
    expect(rows.map(r => r.task?.id)).toEqual(["bt3", "bt1"]);
    expect(rows.every(r => r.assigned)).toBe(true);
  });
});

describe("BugScreen — conflicts and the queue", () => {
  const C = { files: ["a"], base: "main", detectedAt: "", returnTo: "monitoring" as const };
  it("offers Resolve all when bugs wait at the conflict gate", async () => {
    renderScreen([task("conflict", { gate: { kind: "conflict", openedAt: "" }, conflict: C }), task("conflict", { id: "bt2", issue: { ...ISSUE, key: "PAY-43" }, gate: { kind: "conflict", openedAt: "" }, conflict: C })]);
    await userEvent.click(screen.getByRole("button", { name: "Resolve all 2 conflicts" }));
    expect(resolveConflicts).toHaveBeenCalled();
  });
  it("no conflicts, no Resolve all; queued bugs say so in the list", () => {
    renderScreen([task("analyzing", { queuedAt: "2026-10-07T10:00:00Z" })]);
    expect(screen.queryByRole("button", { name: /Resolve all/ })).toBeNull();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Queued (1 of 1)");
  });
});

describe("BugScreen — a link to a bug that hasn't loaded yet", () => {
  // Found by the conflicts e2e: the tracker list arrived before the task list, and the screen
  // "fell back" from #/bugs/bt1 to the first assigned ticket — a reload landed on the wrong bug.
  it("doesn't fall back to another row until the task list has loaded", async () => {
    myIssues.mockResolvedValue(L([{ key: "PAY-1", title: "Other", url: "u", status: "Open", priority: "High" }]));
    const onSelect = vi.fn(); const onSelectTicket = vi.fn();
    render(<BugScreen state={{ ...initial, loaded: false } as never} selectedId="bt1" onSelect={onSelect} onSelectTicket={onSelectTicket} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await new Promise(r => setTimeout(r, 50));                       // the fallback runs in an effect, after the list renders
    expect(onSelectTicket).not.toHaveBeenCalled(); expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("BugScreen — the cached list (spec 2026-10-08 §3)", () => {
  it("says how fresh the list is, and shows a refresh in progress", async () => {
    myIssues.mockResolvedValue(L([{ key: "PAY-1", title: "One", url: "u", status: "Open", priority: "High" }], { refreshing: true }));
    renderScreen([]);
    expect(await screen.findByText(/updated 2 min ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();
  });
  it("a tracker error keeps the last list, with the reason", async () => {
    myIssues.mockResolvedValue(L([{ key: "PAY-1", title: "One", url: "u", status: "Open", priority: "High" }], { error: "rate limited" }));
    renderScreen([]);
    expect(await screen.findByText(/Couldn't refresh from the tracker: rate limited/)).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
  it("a newer list from the server (an event) replaces what it fetched", async () => {
    myIssues.mockResolvedValue(L([]));
    const state = { ...stateWith([]), tracker: L([{ key: "PAY-5", title: "Pushed", url: "u", status: "Open", priority: "High" }], { fetchedAt: new Date().toISOString() }) };
    render(<BugScreen state={state as never} selectedId={null} onSelect={vi.fn()} onSelectTicket={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    expect(await screen.findByText("Pushed")).toBeInTheDocument();
  });
});

describe("BugScreen — picking several bugs", () => {
  const MINE = [{ key: "PAY-1", title: "One", url: "u", status: "Open", priority: "High" }, { key: "PAY-2", title: "Two", url: "u", status: "Open", priority: "Low" }];
  it("not-started bugs can be ticked; started ones can't; Select all and Clear", async () => {
    myIssues.mockResolvedValue(L([...MINE, { key: "PAY-42", title: "Started", url: "u", status: "Open", priority: "High" }]));
    renderScreen([task("implementing")]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(screen.getByLabelText("Select PAY-1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select PAY-42")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Select all not started (2)" }));
    expect(screen.getByLabelText("Select PAY-1")).toBeChecked(); expect(screen.getByLabelText("Select PAY-2")).toBeChecked();
    expect(screen.getByTestId("bulk-start")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("bulk-start")).toBeNull();
  });
  it("ticking doesn't open the ticket", async () => {
    myIssues.mockResolvedValue(L(MINE));
    const onSelectTicket = vi.fn();
    renderScreen([], null, { onSelectTicket });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    onSelectTicket.mockClear();
    await userEvent.click(screen.getByLabelText("Select PAY-2"));
    expect(onSelectTicket).not.toHaveBeenCalled();
    expect(screen.getByTestId("bulk-start")).toBeInTheDocument();
  });
});

describe("BugScreen — a start-many run stays on screen", () => {
  // Found by the bulk e2e: as each picked bug started it stopped being "not started", left the
  // selection, and the progress panel vanished mid-run.
  it("keeps the panel (with its progress) after the picked bugs start, until Done", async () => {
    const MINE = [{ key: "PAY-1", title: "One", url: "u", status: "Open", priority: "High" }];
    myIssues.mockResolvedValue(L(MINE));
    const { rerender } = render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onSelectTicket={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    await userEvent.click(await screen.findByLabelText("Select PAY-1"));
    await userEvent.type(screen.getByLabelText("Repo for PAY"), "/r/pay");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start 1 fix" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Start 1 fix" }));
    const started = { ...stateWith([task("analyzing", { issue: { ...ISSUE, key: "PAY-1", title: "One" } })]),
      batches: { b1: { batchId: "b1", total: 1, done: 1, finished: true, started: [{ key: "PAY-1", taskId: "bt1" }], skipped: [], failed: [] } } };
    rerender(<BugScreen state={started as never} selectedId={null} onSelect={vi.fn()} onSelectTicket={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    expect(screen.getByTestId("bulk-start")).toHaveTextContent("Started 1 of 1");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("bulk-start")).toBeNull();
  });
});

describe("BugScreen — the list stays honest (final review #2, #7)", () => {
  it("a cleared list (the tracker changed) replaces the old one, even though it has no time yet", async () => {
    myIssues.mockResolvedValue(L([{ key: "OLD-1", title: "Old tracker's bug", url: "u", status: "Open", priority: "High" }]));
    const { rerender } = render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onSelectTicket={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    expect(await screen.findByText("Old tracker's bug")).toBeInTheDocument();
    rerender(<BugScreen state={{ ...stateWith([]), tracker: L([], { fetchedAt: null, refreshing: true, generation: 1 }) } as never} selectedId={null} onSelect={vi.fn()} onSelectTicket={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Old tracker's bug")).toBeNull());
  });
  it("an open screen asks again every minute (the server refreshes when the list has gone stale)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderScreen([]);
      await waitFor(() => expect(myIssues).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(myIssues).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
