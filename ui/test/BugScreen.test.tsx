import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BugScreen } from "../src/components/BugScreen";
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
vi.mock("../src/api", () => ({
  ApiError,
  api: {
    getSetup: () => getSetup(), bugPlan: () => bugPlan(), bugDiff: () => bugDiff(),
    approveBug: (id: string, m?: string) => (m ? approveBug(id, m) : approveBug(id)),
    requestBugChanges: vi.fn(), cancelBug: vi.fn(), retryBug: vi.fn(), listBugTasks: vi.fn(async () => []),
    addressComments: vi.fn(), dismissBug: vi.fn(),
  },
}));

const ISSUE = { key: "PAY-42", title: "Refresh token rotates twice", url: "https://x/PAY-42", status: "Open", priority: "High", description: "", acceptanceCriteria: [] as string[] };
function task(stage: BugTask["stage"], extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: ISSUE, trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@r",
    stage, gate: stage === "plan-review" ? { kind: "plan", openedAt: "" } : stage === "diff-review" ? { kind: "diff", openedAt: "" } : stage === "approved" ? { kind: "merge", openedAt: "" } : null,
    mergePolicy: "ask", mergeMethod: "squash", approvedHead: null, outcome: null, checksRoundHead: null, pr: null, prCheckedAt: null,
    costUsd: 0.4, history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage, at: "2026-10-05T10:05:00Z", note: "" }], error: null,
    createdAt: "", updatedAt: "2026-10-05T10:05:00Z", feedbackRounds: 0, assumptions: [], assumptionsProblem: null, ...extra };
}

beforeEach(() => { vi.clearAllMocks(); getSetup.mockImplementation(async () => SETUP); });

import { initial } from "../src/state/reducer";

const stateWith = (tasks: BugTask[]) => ({ ...initial, bugTasks: Object.fromEntries(tasks.map(t => [t.id, t])) });
const renderScreen = (tasks: BugTask[], selectedId: string | null = tasks[0]?.id ?? null, extra = {}) => {
  const onSelect = vi.fn();
  render(<BugScreen state={stateWith(tasks) as never} selectedId={selectedId} onSelect={onSelect} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={vi.fn()} {...extra} />);
  return { onSelect };
};

describe("BugScreen", () => {
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
    await userEvent.click(screen.getByText("Ticket"));
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
    expect(onSelect).toHaveBeenCalledWith("bt1");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("PAY-42");
  });

  it("has an empty state with a way to start", () => {
    const onFixBug = vi.fn();
    render(<BugScreen state={stateWith([]) as never} selectedId={null} onSelect={vi.fn()} onBugChanged={vi.fn()} onTranscript={vi.fn()} onOpenSettings={vi.fn()} onFixBug={onFixBug} />);
    expect(screen.getByText(/no bug fixes yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🐞 Fix a bug" })).toBeInTheDocument();
  });

  it("says when setup could not be checked", async () => {
    getSetup.mockRejectedValueOnce(new Error("down"));
    renderScreen([task("implementing")]);
    expect(await screen.findByText("Could not check setup")).toBeInTheDocument();
  });
});
