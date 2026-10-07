import type { Assumption, BugStage, BugTask, Pending, SessionActivity, SetupReport } from "./types";

// Copies of the server's stage groups (types.ts there exports them as values, but the ui only
// imports server *types*). `bugView.test.ts` pins these equal to the server's.
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr", "review-feedback", "rebase"];
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review", "approved", "conflict"];
export const SERVER_STAGES: BugStage[] = ["pushing", "creating-pr", "merging"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
const UNREACHABLE = "could not check the pull request:";

const LABELS: Record<BugStage, string> = {
  intake: "Setting up", analyzing: "Analyzing", "plan-review": "Plan review", implementing: "Implementing",
  "diff-review": "Diff review", "opening-pr": "Writing the PR", pushing: "Pushing the branch",
  "creating-pr": "Opening the pull request", monitoring: "Watching the PR", "review-feedback": "Addressing review",
  rebase: "Rebasing", approved: "Ready to merge", merging: "Merging", done: "Done", cancelled: "Cancelled", failed: "Failed",
  conflict: "Conflict",
};
export const stageLabel = (s: BugStage): string => LABELS[s];

export type StepState = "done" | "current" | "waiting" | "failed" | "cancelled" | "todo";
export interface Step { id: string; label: string; state: StepState; badge?: string }
const STEPS: Array<{ id: string; label: string; stages: BugStage[] }> = [
  { id: "intake", label: "Intake", stages: ["intake"] },
  { id: "analyze", label: "Analyze", stages: ["analyzing"] },
  { id: "plan", label: "Plan review", stages: ["plan-review"] },
  { id: "implement", label: "Implement", stages: ["implementing"] },
  { id: "diff", label: "Diff review", stages: ["diff-review"] },
  { id: "pr", label: "Open PR", stages: ["opening-pr", "pushing", "creating-pr"] },
  { id: "monitor", label: "Monitor", stages: ["monitoring", "review-feedback", "rebase", "conflict"] },
  { id: "merge", label: "Merge", stages: ["approved", "merging", "done"] },
];

/** The stage that says where the task *is*: for a failed/cancelled task, the last real stage. */
function positionStage(task: BugTask): BugStage {
  if (task.stage !== "failed" && task.stage !== "cancelled") return task.stage;
  return [...task.history].reverse().find(h => !TERMINAL_STAGES.includes(h.stage))?.stage ?? "intake";
}

export function pipelineFor(task: BugTask, agentWaiting: boolean): Step[] {
  const pos = positionStage(task);
  // A diff gate reopened by a review round or a rebase comes after the PR exists: it belongs on
  // Monitor, not before "Open PR" — the strip must not say the PR was never reached.
  const afterPr = pos === "diff-review" && (!!task.gate?.reason || !!task.pr);
  const at = afterPr ? STEPS.findIndex(s => s.id === "monitor") : Math.max(0, STEPS.findIndex(s => s.stages.includes(pos)));
  return STEPS.map((s, i): Step => {
    let state: StepState;
    if (task.stage === "done") state = "done";
    else if (i < at) state = "done";
    else if (i > at) state = "todo";
    else if (task.stage === "failed") state = "failed";
    else if (task.stage === "cancelled") state = "cancelled";
    else if (GATE_STAGES.includes(task.stage) || agentWaiting) state = "waiting";
    else state = "current";
    return { id: s.id, label: s.label, state, ...(s.id === "monitor" && task.feedbackRounds > 0 ? { badge: `round ${task.feedbackRounds}` } : {}) };
  });
}

export type ListStatus = "running" | "waiting" | "failed" | "done" | "cancelled";
export function listStatus(task: BugTask, agentWaiting: boolean): ListStatus {
  if (task.stage === "failed" || task.stage === "cancelled" || task.stage === "done") return task.stage;
  return GATE_STAGES.includes(task.stage) || agentWaiting ? "waiting" : "running";
}

/** Agent text → one plain line: markdown syntax and newlines out, capped. */
function oneLine(text: string, max = 140): string {
  // Only markdown *syntax* goes: fences, line-leading # and >, links (kept as their text), code
  // ticks, and emphasis markers that open at a word boundary. A blanket strip of * and _ turned
  // `src/__tests__/foo_bar.ts` into a path that does not exist.
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/(^|[\s(])(\*\*|__|\*|_)(\S(?:.*?\S)?)\2(?=[\s).,!?:;]|$)/gm, "$1$3")
    .replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
}

function gateHeadline(task: BugTask): string {
  const g = task.gate;
  if (!g) return "";
  if (g.kind === "plan") return "Waiting on you: approve the plan";
  if (g.kind === "conflict") return `Waiting on you: resolve the conflict with ${task.conflict?.base ?? task.baseBranch}`;
  if (g.kind === "diff") return g.reason === "rebase" ? "Waiting on you: review the rebased branch"
    : g.reason === "feedback" ? "Waiting on you: review the changes made for the reviewers"
    : g.reason === "external" ? "Waiting on you: review the pull request opened outside AgentGrid" : "Waiting on you: review the diff";
  return "Waiting on you: merge the pull request";
}

/** `sinceKind` says how to read `since`: how long a stage has been running, how long a gate has
 *  been waiting, or when the PR was last checked — a bare "6 min ago" reads as a timestamp. */
export interface Now { headline: string; detail?: string; since?: string; sinceKind?: "running" | "waiting" | "checked" }
export function nowFor({ task, pending, activity, queue }: { task: BugTask; pending: Pending | null; activity: SessionActivity | null; queue?: { position: number; of: number } }): Now {
  const since = task.history.at(-1)?.at;
  // Waiting for a slot under the agents-at-once limit (spec 2026-10-07 §5).
  if (task.queuedAt && !TERMINAL_STAGES.includes(task.stage)) return { headline: queue ? `Queued (${queue.position} of ${queue.of})` : "Queued", detail: `${stageLabel(task.stage)} starts when an agent is free`, since: task.queuedAt, sinceKind: "waiting" };
  if (task.stage === "conflict") return { headline: `Conflicts with ${task.conflict?.base ?? task.baseBranch}`, ...(task.conflict?.files.length ? { detail: task.conflict.files.join(", ") } : {}), since: task.gate?.openedAt || since, sinceKind: "waiting" };
  if (task.stage === "done" && task.outcome === "no-change") return { headline: "Closed — no change needed" };
  if (task.stage === "done") return { headline: task.outcome === "closed" || (!task.outcome && task.pr?.state === "CLOSED") ? "Closed without merging" : "Merged" };
  if (task.stage === "cancelled") return { headline: "Cancelled" };
  if (task.stage === "failed") return { headline: `Failed while ${stageLabel(positionStage(task)).toLowerCase()}` };
  if (task.gate) return { headline: gateHeadline(task), since: task.gate.openedAt || since, sinceKind: "waiting" };
  if (pending) return { headline: `${stageLabel(task.stage)} · waiting on you`, detail: pending.kind === "question" ? "The agent has a question" : `The agent wants to run ${pending.toolName}` };
  if (task.stage === "pushing") return { headline: "AgentGrid is pushing the branch", since, sinceKind: "running" };
  if (task.stage === "creating-pr") return { headline: "AgentGrid is opening the pull request", since, sinceKind: "running" };
  if (task.stage === "merging") return { headline: "AgentGrid is merging", since, sinceKind: "running" };
  if (task.stage === "monitoring") return { headline: task.pr ? `Watching PR #${task.pr.number}` : "Watching the PR", ...(task.prCheckedAt ? { since: task.prCheckedAt, sinceKind: "checked" as const } : {}) };
  if (task.stage === "intake") return { headline: "Setting up the worktree", since, sinceKind: "running" };
  const raw = activity?.runningTool?.summary || activity?.lastMessage || "";
  return { headline: stageLabel(task.stage), since, sinceKind: "running", ...(raw ? { detail: oneLine(raw) } : {}) };
}

/** The latest dispatch whose assumptions were read — the server records it even when that run
 *  reported nothing. Records from before it existed fall back to the last item's run. */
export const newestToken = (task: BugTask): string | null => task.assumptionsToken ?? task.assumptions.at(-1)?.id.split(":")[0] ?? null;
export const isNew = (a: Assumption, task: BugTask): boolean => a.id.split(":")[0] === newestToken(task);

const STAGE_ORDER: BugStage[] = ["analyzing", "implementing", "review-feedback", "rebase"];
export function orderAssumptions(items: Assumption[]): Assumption[] {
  return items.map((a, i) => ({ a, i })).sort((x, y) =>
    (x.a.kind === "question" ? 0 : 1) - (y.a.kind === "question" ? 0 : 1)
    || STAGE_ORDER.indexOf(x.a.stage) - STAGE_ORDER.indexOf(y.a.stage)
    || x.i - y.i).map(x => x.a);
}

export interface Blocker { kind: "gate" | "agent" | "failed" | "pr" | "setup" | "questions"; title: string; detail?: string }
export function blockersFor({ task, pending, setup, setupError }: { task: BugTask; pending: Pending | null; setup: SetupReport | null; setupError: boolean }): Blocker[] {
  if (task.stage === "done" || task.stage === "cancelled") return [];
  if (task.stage === "failed") return [{ kind: "failed", title: `The ${stageLabel(positionStage(task))} stage failed`, ...(task.error ? { detail: task.error } : {}) }];
  const out: Blocker[] = [];
  if (task.gate) out.push({ kind: "gate", title: gateHeadline(task) });
  // Regression tests: what stops this bug coming back (spec 2026-10-07 §3).
  if (task.gate?.kind === "plan" && !task.verdict && (task.plannedTests ?? []).length === 0) out.push({ kind: "gate", title: "The plan names no regression test" });
  if (task.gate?.kind === "diff" && Array.isArray(task.testsInDiff) && task.testsInDiff.length === 0 && task.testOverride?.head !== task.approvedHead) out.push({ kind: "gate", title: "No regression test in this change" });
  if (pending) out.push({ kind: "agent", title: pending.kind === "question" ? "The agent has a question for you" : `The agent wants permission to run ${pending.toolName}` });
  if (task.pr && (task.stage === "monitoring" || task.stage === "approved")) {
    if (task.pr.checks === "FAILURE" || task.pr.checks === "ERROR") out.push({ kind: "pr", title: "Checks are failing" });
    if (task.pr.reviewDecision === "CHANGES_REQUESTED") out.push({ kind: "pr", title: "Reviewers asked for changes" });
    if (task.pr.mergeable === "CONFLICTING") out.push({ kind: "pr", title: `The branch conflicts with ${task.baseBranch}` });
  }
  if (task.conflictCheckError) out.push({ kind: "pr", title: task.conflictCheckError });
  if (task.error?.startsWith(UNREACHABLE)) out.push({ kind: "pr", title: "Could not check the pull request", detail: task.error.slice(UNREACHABLE.length).trim() });
  if (setupError) out.push({ kind: "setup", title: "Could not check setup" });
  else for (const c of setup?.checks ?? []) if (c.blocks && c.state !== "ok") out.push({ kind: "setup", title: c.detail });
  if (task.gate) {
    const n = task.assumptions.filter(a => a.kind === "question" && isNew(a, task)).length;
    if (n) out.push({ kind: "questions", title: `${n} question${n === 1 ? "" : "s"} to answer before approving` });
  }
  return out;
}

export interface PlanSection { title: string; body: string }
export function planSections(md: string): { sections: PlanSection[]; structured: boolean } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sections: PlanSection[] = [];
  let cur: PlanSection = { title: "", body: "" };
  let fence = false;
  const push = () => { cur.body = cur.body.trim(); if (cur.title || cur.body) sections.push(cur); };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { push(); cur = { title: h[1], body: "" }; continue; }
    cur.body += line + "\n";
  }
  push();
  // A bare document title ("# Plan" with nothing under it) is not a section.
  if (sections.length > 1 && !sections[0].body) sections.shift();
  // "## 1. Root cause" and "## 2) Fix" are the usual sections, numbered.
  const bare = (t: string) => t.replace(/^\d+[.)]\s*/, "");
  const structured = sections.some(s => /root cause/i.test(bare(s.title))) && sections.some(s => /^fix\b/i.test(bare(s.title)));
  return structured ? { sections, structured } : { sections: [{ title: "", body: md.trim() }], structured: false };
}

export type DiffRow =
  | { kind: "file"; text: string }
  | { kind: "hunk"; context: string }
  | { kind: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string }
  | { kind: "note"; text: string };

export function parseHunks(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  // Header lines (---, +++, index, mode…) only exist between `diff --git` and the first `@@`.
  // Inside a hunk "--- x" is a removed "-- x" line — an SQL or Lua comment — not a header.
  let oldNo = 0, newNo = 0, renameFrom: string | null = null, inHunk = false;
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (file) { rows.push({ kind: "file", text: file[2] }); renameFrom = null; inHunk = false; continue; }
    const from = /^rename from (.+)$/.exec(line); if (from) { renameFrom = from[1]; continue; }
    const to = /^rename to (.+)$/.exec(line);
    if (to && renameFrom) { const last = [...rows].reverse().find(r => r.kind === "file") as { kind: "file"; text: string } | undefined; if (last) last.text = `${renameFrom} → ${to[1]}`; continue; }
    if (/^Binary files /.test(line)) { rows.push({ kind: "note", text: "Binary file — not shown" }); continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); inHunk = true; rows.push({ kind: "hunk", context: h[3].trim() }); continue; }
    if (line.startsWith("\\ ")) continue;   // "\ No newline at end of file"
    if (!inHunk) continue;                    // a header line
    // Some tools strip the leading space from an empty context line.
    if (line === "") { rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: "" }); continue; }
    if (line.startsWith("+")) rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return rows;
}
