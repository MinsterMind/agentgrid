import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
    createdAt: "", updatedAt: "2026-10-05T10:05:00Z", feedbackRounds: 0, assumptions: [], assumptionsProblem: null, assumptionsToken: null, ...extra };
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
    expect(screen.getByRole("listbox").closest(".buglist")!.querySelector(".lh")).toHaveTextContent(/Bug fixes\s*2/);
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
});
