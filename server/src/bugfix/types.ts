export type BugStage =
  | "intake" | "analyzing" | "plan-review" | "implementing" | "diff-review"
  | "opening-pr" | "monitoring" | "review-feedback" | "rebase" | "approved"
  | "merging" | "done" | "cancelled" | "failed";

export type GateKind = "plan" | "diff" | "review" | "merge" | "rebase";

/** Normalised ticket — every tracker preset returns this shape. */
export interface TrackerIssue {
  key: string; title: string; url: string;
  status: string; priority: string;
  description: string; acceptanceCriteria: string[];
}
export interface IssueSummary { key: string; title: string; url: string; status: string; priority: string }

export interface PrInfo {
  number: number; url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  checks: string | null;
  mergeable: string | null;
  lastSeenEventAt: string;
}

export interface BugTask {
  id: string;                     // "bt1"
  issue: TrackerIssue;
  trackerProject: string;         // e.g. "PAY" — key prefix
  sourceRepo: string;             // the repo the user picked
  worktree: string;               // <repo>/.worktrees/bugfix-<KEY>
  branch: string;                 // bugfix/<KEY>
  baseBranch: string;
  agentId: string;
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string } | null;
  mergePolicy: "ask" | "auto";
  mergeMethod: "squash" | "merge" | "rebase";
  /** The commit HEAD pointed at when the diff gate opened — i.e. exactly what the human
   *  approved. `opening-pr` refuses to run unless HEAD is still this commit. */
  approvedHead: string | null;
  pr: PrInfo | null;
  costUsd: number;
  history: Array<{ stage: BugStage; at: string; note: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BugEvent =
  | { type: "stage-done" }                       // the stage's assignment finished and verified
  | { type: "stage-failed"; reason: string }
  | { type: "approve" }
  | { type: "request-changes"; text: string }
  | { type: "cancel" }
  | { type: "retry" };

export interface Transition {
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string } | null;
  error: string | null;
  note: string;
  /** Stage the engine must now run an assignment for; null when waiting on a human or resting. */
  run: BugStage | null;
}

/** Stages whose work is done by an agent assignment. */
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr"];
/** Stages that are waiting on a human click. */
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
