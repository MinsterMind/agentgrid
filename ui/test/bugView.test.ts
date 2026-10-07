import { describe, it, expect } from "vitest";
import { AGENT_STAGES as SERVER_AGENT, GATE_STAGES as SERVER_GATE, SERVER_STAGES as SERVER_SERVER, TERMINAL_STAGES as SERVER_TERMINAL } from "../../server/src/bugfix/types";
import { AGENT_STAGES, GATE_STAGES, SERVER_STAGES, TERMINAL_STAGES, stageLabel, pipelineFor, listStatus, nowFor, blockersFor, orderAssumptions, isNew, planSections, parseHunks, costByStep, modelName } from "../src/bugView";
import type { Assumption, BugStage, BugTask, SetupReport } from "../src/types";

const ALL: BugStage[] = ["intake", "analyzing", "plan-review", "implementing", "diff-review", "opening-pr", "creating-pr", "monitoring", "review-feedback", "rebase", "pushing", "approved", "merging", "done", "cancelled", "failed"];

function task(stage: BugStage, extra: Partial<BugTask> = {}): BugTask {
  return { id: "bt1", issue: { key: "PAY-42", title: "T", url: "https://x", status: "Open", priority: "High", description: "", acceptanceCriteria: [] },
    trackerProject: "PAY", sourceRepo: "/r", worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", baseRef: "origin/main", ticketCommits: [], verdict: null, report: null, plannedTests: [], testsInDiff: null, testOverride: null, conflict: null, conflictCheckError: null, queuedAt: null, queuedNote: null, trackerSyncError: null, queuedReason: null, commentsSince: null, commentsPendingSince: null, commentsNote: null, imported: false, runs: [], stageModel: {}, agentId: "a1", stage,
    gate: stage === "plan-review" ? { kind: "plan", openedAt: "t" } : stage === "diff-review" ? { kind: "diff", openedAt: "t" } : stage === "approved" ? { kind: "merge", openedAt: "t" } : null,
    mergePolicy: "ask", mergeMethod: "squash", approvedHead: null, outcome: null, checksRoundHead: null, pr: null, prCheckedAt: null,
    costUsd: 0, history: [{ stage: "intake", at: "2026-10-05T10:00:00Z", note: "" }, { stage, at: "2026-10-05T10:05:00Z", note: "" }],
    error: null, createdAt: "", updatedAt: "", feedbackRounds: 0, assumptions: [], assumptionsProblem: null, assumptionsToken: null, ...extra };
}
const A = (over: Partial<Assumption>): Assumption => ({ id: "t1:0", stage: "analyzing", round: 0, kind: "assumption", text: "x", at: "t", ...over });

describe("stage groups", () => {
  it("match the server's", () => {
    expect(AGENT_STAGES).toEqual(SERVER_AGENT); expect(GATE_STAGES).toEqual(SERVER_GATE);
    expect(SERVER_STAGES).toEqual(SERVER_SERVER); expect(TERMINAL_STAGES).toEqual(SERVER_TERMINAL);
  });
});

describe("stageLabel", () => {
  it.each(ALL)("%s has a human label that is not its id", s => {
    expect(stageLabel(s)).toBeTruthy();
    expect(stageLabel(s)).not.toBe(s);
  });
  it("reads review-feedback as Addressing review", () => expect(stageLabel("review-feedback")).toBe("Addressing review"));
});

describe("pipelineFor", () => {
  const states = (t: BugTask, w = false) => pipelineFor(t, w).map(s => s.state);
  it("has the eight steps in order", () => {
    expect(pipelineFor(task("intake"), false).map(s => s.label)).toEqual(["Intake", "Analyze", "Plan review", "Implement", "Diff review", "Open PR", "Monitor", "Merge"]);
  });
  it.each(ALL)("every stage maps to a pipeline without throwing (%s)", s => {
    expect(pipelineFor(task(s), false)).toHaveLength(8);
  });
  it("marks earlier steps done, the running one current, later ones todo", () => {
    expect(states(task("implementing"))).toEqual(["done", "done", "done", "current", "todo", "todo", "todo", "todo"]);
  });
  it("a gate is waiting on you", () => {
    expect(states(task("plan-review"))[2]).toBe("waiting");
    expect(states(task("approved"))[7]).toBe("waiting");
  });
  it("an agent waiting on a permission makes its step waiting", () => {
    expect(states(task("implementing"), true)[3]).toBe("waiting");
  });
  it("groups server stages under their step", () => {
    expect(states(task("creating-pr"))[5]).toBe("current");
    expect(states(task("rebase"))[6]).toBe("current");
  });
  it("a failure marks the step where it happened", () => {
    const t = task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "analyzing", at: "b", note: "" }, { stage: "implementing", at: "c", note: "" }, { stage: "failed", at: "d", note: "" }] });
    expect(states(t)).toEqual(["done", "done", "done", "failed", "todo", "todo", "todo", "todo"]);
  });
  // Review Focus 3.
  it("a failure during intake marks Intake failed", () => {
    const t = task("failed", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "failed", at: "b", note: "" }] });
    expect(states(t)[0]).toBe("failed");
  });
  it("cancelled marks its step cancelled", () => {
    const t = task("cancelled", { history: [{ stage: "intake", at: "a", note: "" }, { stage: "plan-review", at: "b", note: "" }, { stage: "cancelled", at: "c", note: "" }] });
    expect(states(t)[2]).toBe("cancelled");
  });
  it("done marks every step done", () => {
    expect(states(task("done"))).toEqual(Array(8).fill("done"));
  });
  it("Monitor carries the round once there has been one", () => {
    expect(pipelineFor(task("monitoring", { feedbackRounds: 2 }), false)[6].badge).toBe("round 2");
    expect(pipelineFor(task("monitoring"), false)[6].badge).toBeUndefined();
  });
});

describe("listStatus", () => {
  it.each([["implementing", false, "running"], ["plan-review", false, "waiting"], ["implementing", true, "waiting"], ["failed", false, "failed"], ["done", false, "done"], ["cancelled", false, "cancelled"]] as const)(
    "%s (agent waiting: %s) → %s", (s, w, want) => expect(listStatus(task(s), w)).toBe(want));
});

describe("nowFor", () => {
  it("agent stage: label, since the stage began, and the tool it is running", () => {
    const n = nowFor({ task: task("implementing"), pending: null, activity: { sessionId: "s", phase: "working", lastMessage: "Editing", lastPrompt: "", runningTool: { name: "Bash", summary: "npm test" }, updatedAt: "" } as never });
    expect(n).toMatchObject({ headline: "Implementing", detail: "npm test", since: "2026-10-05T10:05:00Z" });
  });
  // Review Focus 5.
  it("activity text becomes one plain, short line", () => {
    const long = "## Heading\n\n**Bold** and `code` " + "word ".repeat(80);
    const n = nowFor({ task: task("implementing"), pending: null, activity: { sessionId: "s", phase: "working", lastMessage: long, lastPrompt: "", updatedAt: "" } as never });
    expect(n.detail).not.toMatch(/\n|##|\*\*|`/);
    expect(n.detail!.length).toBeLessThanOrEqual(141);
  });
  it("a pending permission says the agent is waiting on you", () => {
    const n = nowFor({ task: task("implementing"), pending: { kind: "permission", toolUseId: "u", toolName: "Bash", input: {}, suggestions: [], suggestedRule: "Bash", ruleIsBroad: true }, activity: null });
    expect(n.headline).toMatch(/waiting on you/i);
    expect(n.detail).toMatch(/Bash/);
  });
  it("gates say what you need to do", () => {
    expect(nowFor({ task: task("plan-review"), pending: null, activity: null }).headline).toBe("Waiting on you: approve the plan");
    expect(nowFor({ task: task("diff-review"), pending: null, activity: null }).headline).toBe("Waiting on you: review the diff");
    expect(nowFor({ task: task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "rebase" } }), pending: null, activity: null }).headline).toMatch(/rebased/);
    expect(nowFor({ task: task("approved"), pending: null, activity: null }).headline).toBe("Waiting on you: merge the pull request");
  });
  it("server stages name AgentGrid as the actor", () => {
    expect(nowFor({ task: task("pushing"), pending: null, activity: null }).headline).toBe("AgentGrid is pushing the branch");
  });
  it("monitoring names the PR", () => {
    const pr = { number: 12, url: "u", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "" };
    expect(nowFor({ task: task("monitoring", { pr, prCheckedAt: "2026-10-05T10:00:00Z" }), pending: null, activity: null })).toMatchObject({ headline: "Watching PR #12", since: "2026-10-05T10:00:00Z" });
  });
  it("terminal stages state the outcome", () => {
    expect(nowFor({ task: task("done", { outcome: "merged" }), pending: null, activity: null }).headline).toBe("Merged");
    expect(nowFor({ task: task("done", { outcome: "closed" }), pending: null, activity: null }).headline).toBe("Closed without merging");
    expect(nowFor({ task: task("done", { outcome: "no-change" }), pending: null, activity: null }).headline).toBe("Closed — no change needed");
    expect(nowFor({ task: task("cancelled"), pending: null, activity: null }).headline).toBe("Cancelled");
  });
});

describe("blockersFor", () => {
  const base = { pending: null, setup: null, setupError: false };
  it("nothing blocking a running stage", () => expect(blockersFor({ ...base, task: task("implementing") })).toEqual([]));
  it("an open gate", () => expect(blockersFor({ ...base, task: task("plan-review", { plannedTests: ["t"] }) })).toEqual([{ kind: "gate", title: "Waiting on you: approve the plan" }]));
  it("a pending agent request", () => expect(blockersFor({ ...base, task: task("implementing"), pending: { kind: "question", toolUseId: "u", toolName: "AskUserQuestion", input: {}, suggestedRule: "", ruleIsBroad: false, suggestions: [] } })[0].kind).toBe("agent"));
  it("a failed stage carries its error", () => {
    const t = task("failed", { error: "no commits on the task branch", history: [{ stage: "intake", at: "a", note: "" }, { stage: "implementing", at: "b", note: "" }, { stage: "failed", at: "c", note: "" }] });
    expect(blockersFor({ ...base, task: t })).toEqual([{ kind: "failed", title: "The Implementing stage failed", detail: "no commits on the task branch" }]);
  });
  it("PR problems while monitoring", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, reviewDecision: "CHANGES_REQUESTED", checks: "FAILURE", mergeable: "CONFLICTING", headSha: null, lastSeenEventAt: "" };
    expect(blockersFor({ ...base, task: task("monitoring", { pr }) }).map(b => b.title)).toEqual(["Checks are failing", "Reviewers asked for changes", "The branch conflicts with main"]);
  });
  it("an unreachable PR", () => {
    expect(blockersFor({ ...base, task: task("monitoring", { error: "could not check the pull request: timeout" }) })).toEqual([{ kind: "pr", title: "Could not check the pull request", detail: "timeout" }]);
  });
  it("blocking setup problems, and saying when setup could not be checked", () => {
    const setup = { ready: true, wired: true, addCommand: "", discovery: { servers: [], problems: [] }, checks: [
      { id: "role", state: "missing", blocks: true, detail: "The bugfix role could not be resolved." },
      { id: "forge-token", state: "missing", blocks: false, detail: "no token" },
    ] } as SetupReport;
    expect(blockersFor({ ...base, task: task("implementing"), setup })).toEqual([{ kind: "setup", title: "The bugfix role could not be resolved." }]);
    expect(blockersFor({ ...base, task: task("implementing"), setupError: true })).toEqual([{ kind: "setup", title: "Could not check setup" }]);
  });
  it("open questions from the latest run, at a gate", () => {
    const t = task("plan-review", { assumptions: [A({ id: "old:0", kind: "question" }), A({ id: "new:0", kind: "question" }), A({ id: "new:1", kind: "question" })] });
    expect(blockersFor({ ...base, task: t })).toContainEqual({ kind: "questions", title: "2 questions to answer before approving" });
  });
  it("a finished task has no setup or PR blockers", () => {
    const setup = { checks: [{ id: "role", state: "missing", blocks: true, detail: "x" }] } as unknown as SetupReport;
    expect(blockersFor({ ...base, task: task("done"), setup })).toEqual([]);
  });
});

describe("assumptions ordering and newness", () => {
  it("questions first, then workflow order, then oldest first", () => {
    const items = [A({ id: "b:0", stage: "implementing", text: "impl" }), A({ id: "a:0", stage: "analyzing", text: "an" }), A({ id: "b:1", stage: "implementing", kind: "question", text: "q" })];
    expect(orderAssumptions(items).map(i => i.text)).toEqual(["q", "an", "impl"]);
  });
  it("items from the most recent run are new", () => {
    const t = task("plan-review", { assumptions: [A({ id: "a:0" }), A({ id: "b:0" })] });
    expect(isNew(t.assumptions[0], t)).toBe(false);
    expect(isNew(t.assumptions[1], t)).toBe(true);
  });
});

describe("planSections", () => {
  it("splits a plan into its titled sections and drops a bare document title", () => {
    const r = planSections("# Plan\n\n## Root cause\nA\n\n## Fix\nB\n\n## Test strategy\nC\n\n## Risks and anything you are unsure about\nD");
    expect(r.structured).toBe(true);
    expect(r.sections).toEqual([{ title: "Root cause", body: "A" }, { title: "Fix", body: "B" }, { title: "Test strategy", body: "C" }, { title: "Risks and anything you are unsure about", body: "D" }]);
  });
  it("keeps an extra section the agent added", () => {
    expect(planSections("## Root cause\nA\n## Fix\nB\n## Files to touch\n- x").sections.map(s => s.title)).toEqual(["Root cause", "Fix", "Files to touch"]);
  });
  it("accepts any heading level", () => {
    expect(planSections("### Root cause\nA\n# Fix\nB").structured).toBe(true);
  });
  it("is unstructured without a root cause and a fix", () => {
    const r = planSections("## Fix\nB");
    expect(r.structured).toBe(false);
  });
  // Review Focus 2.
  it("a plan using bold lines instead of headings is one unstructured section", () => {
    const r = planSections("**Root cause**\nA\n\n**Fix**\nB");
    expect(r.structured).toBe(false);
    expect(r.sections).toEqual([{ title: "", body: "**Root cause**\nA\n\n**Fix**\nB" }]);
  });
  it("ignores # lines inside code fences", () => {
    const r = planSections("## Root cause\n```\n# not a heading\n```\n## Fix\nB");
    expect(r.sections[0].body).toContain("# not a heading");
  });
});

describe("parseHunks", () => {
  const patch = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x",
    "@@ -1,3 +1,3 @@ function f()", " keep", "-old", "+new", " tail",
    "@@ -10,1 +10,2 @@", " ten", "+eleven", "\\ No newline at end of file"].join("\n");
  it("numbers old and new lines across hunks and drops headers and markers", () => {
    expect(parseHunks(patch)).toEqual([
      { kind: "file", text: "x" },
      { kind: "hunk", context: "function f()" },
      { kind: "ctx", oldNo: 1, newNo: 1, text: "keep" },
      { kind: "del", oldNo: 2, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 2, text: "new" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "tail" },
      { kind: "hunk", context: "" },
      { kind: "ctx", oldNo: 10, newNo: 10, text: "ten" },
      { kind: "add", oldNo: null, newNo: 11, text: "eleven" },
    ]);
  });
  it("names a renamed file by its new path and notes binary files", () => {
    const r = parseHunks("diff --git a/old.png b/new.png\nsimilarity index 90%\nrename from old.png\nrename to new.png\nBinary files a/old.png and b/new.png differ");
    expect(r).toEqual([{ kind: "file", text: "old.png → new.png" }, { kind: "note", text: "Binary file — not shown" }]);
  });
describe("final-review fixes", () => {
  // Important #2: "new" is the last dispatch read, not the last item stored.
  it("a question from an earlier run is not new once a later run reported nothing", () => {
    const t = task("diff-review", { assumptionsToken: "impl", assumptions: [A({ id: "an:0", kind: "question" })] });
    expect(isNew(t.assumptions[0], t)).toBe(false);
    expect(blockersFor({ task: t, pending: null, setup: null, setupError: false }).map(b => b.kind)).not.toContain("questions");
  });
  it("records written before the token existed fall back to the last item's run", () => {
    const t = task("plan-review", { assumptionsToken: null, assumptions: [A({ id: "an:0", kind: "question" })] });
    expect(isNew(t.assumptions[0], t)).toBe(true);
  });

  // Important #3: inside a hunk, "--- x" is a removed "-- x" line, not a header.
  it("keeps removed lines that start with -- and added lines that start with ++", () => {
    const rows = parseHunks(["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,3 +1,3 @@",
      " select 1;", "--- drop the old index", "+++ counter", " select 2;"].join("\n"));
    expect(rows.filter(r => r.kind !== "file" && r.kind !== "hunk")).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "select 1;" },
      { kind: "del", oldNo: 2, newNo: null, text: "-- drop the old index" },
      { kind: "add", oldNo: null, newNo: 2, text: "++ counter" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "select 2;" },
    ]);
  });
  it("an empty line inside a hunk is an empty context line, not dropped", () => {
    const rows = parseHunks("diff --git a/x b/x\n@@ -1,3 +1,3 @@\n a\n\n b");
    expect(rows.filter(r => r.kind === "ctx").map(r => (r as { newNo: number }).newNo)).toEqual([1, 2, 3]);
  });

  // Important #5: a diff gate reopened after the PR exists sits on Monitor, not before the PR.
  it("a diff gate reopened by a review round is placed on Monitor", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "" };
    const t = task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "feedback" }, pr, feedbackRounds: 1 });
    expect(pipelineFor(t, false).map(s => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "waiting", "todo"]);
  });

  // Re-graded minor: the Now line must not corrupt paths or keep link syntax.
  it("the Now line keeps paths intact and turns links into their text", () => {
    const n = nowFor({ task: task("implementing"), pending: null, activity: { sessionId: "s", phase: "working", lastMessage: "Editing src/__tests__/foo_bar.ts — see [docs](http://x) and **this**", lastPrompt: "", updatedAt: "" } as never });
    expect(n.detail).toBe("Editing src/__tests__/foo_bar.ts — see docs and this");
  });
});
describe("deferred minors", () => {
  it("numbered headings still count as the usual sections", () => {
    const r = planSections("## 1. Root cause\nA\n## 2) Fix\nB");
    expect(r.structured).toBe(true);
    expect(r.sections.map(s => s.title)).toEqual(["1. Root cause", "2) Fix"]);
  });
  it("says how to read the time beside the Now line", () => {
    const pr = { number: 1, url: "u", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "" };
    expect(nowFor({ task: task("implementing"), pending: null, activity: null }).sinceKind).toBe("running");
    expect(nowFor({ task: task("plan-review"), pending: null, activity: null }).sinceKind).toBe("waiting");
    expect(nowFor({ task: task("monitoring", { pr, prCheckedAt: "2026-10-05T10:00:00Z" }), pending: null, activity: null }).sinceKind).toBe("checked");
  });
});
describe("a pull request opened outside AgentGrid", () => {
  it("names it in the gate headline", () => {
    const t = task("diff-review", { gate: { kind: "diff", openedAt: "t", reason: "external" } });
    expect(nowFor({ task: t, pending: null, activity: null }).headline).toBe("Waiting on you: review the pull request opened outside AgentGrid");
  });
});
});

describe("blockersFor — regression tests", () => {
  const base = { pending: null, setup: null, setupError: false };
  it("a change-needed plan that names no regression test is a blocker at the plan gate", () => {
    const titles = (t: ReturnType<typeof task>) => blockersFor({ ...base, task: t }).map(b => b.title);
    expect(titles(task("plan-review", { gate: { kind: "plan", openedAt: "" }, plannedTests: [] }))).toContain("The plan names no regression test");
    expect(titles(task("plan-review", { gate: { kind: "plan", openedAt: "" }, plannedTests: ["t"] }))).not.toContain("The plan names no regression test");
    expect(titles(task("plan-review", { gate: { kind: "plan", openedAt: "" }, plannedTests: [], verdict: "already fixed" }))).not.toContain("The plan names no regression test");
  });
  it("a diff with no test file is a blocker until overridden for this head", () => {
    const titles = (t: ReturnType<typeof task>) => blockersFor({ ...base, task: t }).map(b => b.title);
    const diff = { gate: { kind: "diff" as const, openedAt: "" }, approvedHead: "h1" };
    expect(titles(task("diff-review", { ...diff, testsInDiff: [] }))).toContain("No regression test in this change");
    expect(titles(task("diff-review", { ...diff, testsInDiff: ["a.test.ts"] }))).not.toContain("No regression test in this change");
    expect(titles(task("diff-review", { ...diff, testsInDiff: [], testOverride: { reason: "r", at: "", head: "h1" } }))).not.toContain("No regression test in this change");
    expect(titles(task("diff-review", { ...diff, testsInDiff: null }))).not.toContain("No regression test in this change");
  });
});

describe("conflicts and the queue", () => {
  const C = { files: ["src/a.ts", "src/b.ts"], base: "develop", detectedAt: "2026-10-07T10:00:00Z", returnTo: "monitoring" as const };
  it("a conflict says what it conflicts with, and which files", () => {
    const n = nowFor({ task: task("conflict", { gate: { kind: "conflict", openedAt: "" }, conflict: C }), pending: null, activity: null });
    expect(n.headline).toBe("Conflicts with develop"); expect(n.detail).toBe("src/a.ts, src/b.ts");
    expect(listStatus(task("conflict", { gate: { kind: "conflict", openedAt: "" } }), false)).toBe("waiting");
  });
  it("a queued run says its place in line", () => {
    const n = nowFor({ task: task("analyzing", { queuedAt: "2026-10-07T10:00:00Z" }), pending: null, activity: null, queue: { position: 2, of: 3 } });
    expect(n.headline).toBe("Queued (2 of 3)");
  });
  it("a conflict check that couldn't run is a blocker", () => {
    const b = blockersFor({ task: task("monitoring", { conflictCheckError: "Couldn't check for conflicts: could not resolve host" }), pending: null, setup: null, setupError: false });
    expect(b.map(x => x.title)).toContain("Couldn't check for conflicts: could not resolve host");
  });
});

describe("blockersFor — the tracker's status", () => {
  it("a status move that failed shows on the card", () => {
    const b = blockersFor({ task: task("monitoring", { trackerSyncError: "Couldn't move PAY-42 to In Review: no such transition" }), pending: null, setup: null, setupError: false });
    expect(b.map(x => x.title)).toContain("Couldn't move PAY-42 to In Review: no such transition");
  });
});

describe("cost per step and the token notes (spec 2026-10-09 §6.4–§6.5)", () => {
  it("costByStep sums runs per step and names the models used", () => {
    const t = task("diff-review", { runs: [
      { stage: "analyzing", model: "claude-opus-5", costUsd: 1.2, at: "a", ok: true },
      { stage: "implementing", model: "claude-sonnet-5-5", costUsd: 0.5, at: "b", ok: false },
      { stage: "implementing", model: "claude-opus-5", costUsd: 0.75, at: "c", ok: true },
    ] });
    expect(costByStep(t)).toEqual([
      { stage: "analyzing", label: stageLabel("analyzing"), usd: 1.2, models: ["Opus"] },
      { stage: "implementing", label: stageLabel("implementing"), usd: 1.25, models: ["Sonnet", "Opus"] },
    ]);
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku");
    expect(modelName("other")).toBe("other");
  });
  it("a held run, waiting reviewer comments and an unknown self are notes on the card", () => {
    const base = { pending: null, setup: null, setupError: false };
    const titles = (t: BugTask) => blockersFor({ ...base, task: t }).map(b => b.title);
    expect(titles(task("analyzing", { queuedAt: "t", queuedReason: "Daily limit reached ($20.00 of $20.00)" }))).toContain("Daily limit reached ($20.00 of $20.00)");
    expect(titles(task("monitoring", { commentsPendingSince: "t" }))).toContain("Reviewer comments waiting — a round starts after the quiet period");
    expect(titles(task("monitoring", { commentsNote: "Couldn't tell which comments are yours: x" }))).toContain("Couldn't tell which comments are yours: x");
  });
});
