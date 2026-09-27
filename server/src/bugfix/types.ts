export type BugStage =
  | "intake" | "analyzing" | "plan-review" | "implementing" | "diff-review"
  | "opening-pr" | "monitoring" | "review-feedback" | "rebase" | "pushing"
  | "approved" | "merging" | "done" | "cancelled" | "failed";

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
  /** `gh`'s `headRefOid` — the server's only proof that a push actually landed on the PR. */
  headSha: string | null;
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
  gate: { kind: GateKind; openedAt: string; reason?: "feedback" | "rebase" } | null;
  mergePolicy: "ask" | "auto";
  mergeMethod: "squash" | "merge" | "rebase";
  /** The commit HEAD pointed at when the diff gate opened — i.e. exactly what the human
   *  approved. `opening-pr` refuses to run unless HEAD is still this commit. */
  approvedHead: string | null;
  pr: PrInfo | null;
  /** When `pr` was actually read from the forge (ISO), as opposed to `pr.lastSeenEventAt`,
   *  which is the forge's own `updatedAt` for the pull request. Two things need it: the card's
   *  "Last checked", and `BugTaskStore.patchPr`'s staleness rule — the watcher writes PR views
   *  outside the engine's per-task lock, so a tick whose `getPr` was already in flight must not
   *  be able to land its pre-merge view on top of the merge's own bookkeeping. Records written
   *  before this field existed normalise to null in `BugTaskStore.init`. */
  prCheckedAt: string | null;
  costUsd: number;
  history: Array<{ stage: BugStage; at: string; note: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Incremented when a review-feedback stage is dispatched. Durable, so a restart cannot
   *  reset a task's budget against the cap. Tasks persisted before this field existed are
   *  normalised to 0 in `BugTaskStore.init` — the one place old records enter the system —
   *  so every consumer here can treat it as an honest `number`. */
  feedbackRounds: number;
}

export type BugEvent =
  | { type: "stage-done" }                       // the stage's assignment finished and verified
  | { type: "stage-failed"; reason: string }
  | { type: "approve" }
  | { type: "request-changes"; text: string }
  | { type: "cancel" }
  | { type: "retry" }
  /** `source` says whose words `comments` are, and therefore whether the agent may obey them:
   *  "forge" is reviewer/CI text pulled off the pull request (data, fenced in the prompt);
   *  "operator" is the human at the console typing into this app. The watcher only ever
   *  produces "forge"; `addressComments` produces either, depending on whether the human
   *  supplied the text themselves. */
  | { type: "review-changes-requested"; comments: string; source: "forge" | "operator" }
  | { type: "checks-failed"; checks: string }
  | { type: "review-approved" }
  | { type: "conflicting" }
  | { type: "pr-closed" }
  | { type: "pr-merged" };

export interface Transition {
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string; reason?: "feedback" | "rebase" } | null;
  error: string | null;
  note: string;
  /** Stage the engine must now run an assignment for; null when waiting on a human or resting
   *  (a gate stage), or when a server stage is what's next (the engine runs it, not an agent). */
  run: BugStage | null;
}

/** Stages whose work is done by an agent assignment. */
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr", "review-feedback", "rebase"];
/** Stages that are waiting on a human click. */
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review", "approved"];
/** Stages the ENGINE performs itself — no assignment, no agent, no tokens. They still
 *  report stage-done/stage-failed, so failure and retry work exactly as for agent stages. */
export const SERVER_STAGES: BugStage[] = ["pushing", "merging"];
/** Resting stages the watcher polls. Never an agent stage: two things driving one task is
 *  the bug class Phase 1 spent its Criticals on. */
export const WATCHED_STAGES: BugStage[] = ["monitoring", "approved"];
/** Agent stages dispatched to resolve a review round; distinct from the other AGENT_STAGES
 *  because they're the ones a feedback-round budget must count against. */
export const FEEDBACK_AGENT_STAGES: BugStage[] = ["review-feedback", "rebase"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
/**
 * Stages a startup crash can strand a task in with nothing left to finish it: the
 * AGENT_STAGES (an assignment was dispatched but never reported back), "intake" (the task
 * record was written, but the transition into "analyzing" never landed), and the
 * SERVER_STAGES ("pushing"/"merging" — the engine itself was mid-step, with no assignment
 * to report back either). A crash mid-"merging" is the worst place in the whole workflow
 * to have no way out: nothing — not the user, not the server — otherwise knows whether the
 * merge actually landed, and neither `retry` (which requires "failed") nor any other event
 * is legal from a server stage. Recovery fails tasks sitting in any of these so they get a
 * card and a working Retry instead of being silently orphaned. Retrying back into "merging"
 * or "pushing" is safe: `doMerge` re-reads the PR before merging (a merge that already
 * landed short-circuits into a teardown-only pass, never a second `forge.merge` call — see
 * its own comment on the entry-route discriminator, which still resolves to "approved"
 * through the interposed "failed"), and `doPush` re-checks the pin and pushes a branch that
 * may already be pushed, which is a no-op.
 */
export const RECOVERABLE_STAGES: BugStage[] = ["intake", ...AGENT_STAGES, ...SERVER_STAGES];
