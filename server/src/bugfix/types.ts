export type BugStage =
  | "intake" | "analyzing" | "plan-review" | "implementing" | "diff-review"
  | "opening-pr" | "creating-pr" | "monitoring" | "review-feedback" | "rebase" | "pushing"
  | "approved" | "merging" | "done" | "cancelled" | "failed"
  /** The PR conflicts with its base: waiting for the human to allow a rebase (spec 2026-10-07 §4.2). */
  | "conflict";

/** A gate's kind is what the card renders. There is no "rebase" gate: a rebase round lands at the
 *  DIFF gate carrying `reason: "rebase"` (see `Transition.gate`), which is what labels it. */
export type GateKind = "plan" | "diff" | "review" | "merge" | "conflict";

/** Normalised ticket — every tracker preset returns this shape. */
export interface TrackerIssue {
  key: string; title: string; url: string;
  status: string; priority: string;
  description: string; acceptanceCriteria: string[];
}
export interface IssueSummary { key: string; title: string; url: string; status: string; priority: string }

/** One thing an agent stage reported it assumed, or could not decide. Agent-written text:
 *  rendered as text, never as HTML, never fed back into a prompt. */
export interface Assumption {
  /** "<dispatch token>:<index>" — stable across re-renders, and the token groups one run's items. */
  id: string;
  stage: BugStage;
  /** `feedbackRounds` when the stage was dispatched; 0 for analyze/implement. */
  round: number;
  kind: "assumption" | "question";
  text: string;
  /** When the engine read it (ISO). */
  at: string;
}

export interface PrInfo {
  number: number; url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  reviewDecision: string | null;
  checks: string | null;
  mergeable: string | null;
  /** `gh`'s `headRefOid` — the server's only proof that a push actually landed on the PR. */
  headSha: string | null;
  lastSeenEventAt: string;
  /** The PR's own branch, the branch it targets, and its title — from a listing; what an import matches a ticket by (spec 2026-10-09 §3). */
  headBranch?: string | null; baseBranch?: string | null; title?: string | null;
}

export interface BugTask {
  id: string;                     // "bt1"
  issue: TrackerIssue;
  trackerProject: string;         // e.g. "PAY" — key prefix
  sourceRepo: string;             // the repo the user picked
  worktree: string;               // <repo>/.worktrees/bugfix-<KEY>
  branch: string;                 // bugfix/<KEY>
  baseBranch: string;             // the branch the PR targets, e.g. "develop"
  /** The ref the branch was cut from and every diff/commit count compares against — `origin/<baseBranch>`
   *  after a fetch. Never a local branch: those go stale, or (PULSEAI-414) sit at a repo's first commit.
   *  Records written before 0.10.1 normalise to `baseBranch`. */
  baseRef: string;
  /** Commits already on `baseRef` that name the ticket, found at intake — the agent checks them first. */
  ticketCommits: string[];
  /** The plan's own "Verdict: no change needed — <why>", when it says so; null when it says a change is needed. */
  verdict: string | null;
  /** Why a task closed without a change: the evidence and what to do with the ticket. Null otherwise. */
  report: string | null;
  /** The plan's "Regression tests" items — what stops this bug coming back. Records before 0.12.0 normalise to []. */
  plannedTests: string[];
  /** Test files in the diff the human is reviewing (null for records before 0.12.0, which never block). */
  testsInDiff: string[] | null;
  /** "Approve without a regression test", with the reason — valid only for the head it was given at. */
  testOverride: { reason: string; at: string; head: string } | null;
  /** What the PR conflicts on, while it waits at the conflict gate (kept through the rebase it allows). */
  conflict: { files: string[]; base: string; detectedAt: string; returnTo: "monitoring" | "approved" } | null;
  /** Why the last conflict check couldn't run (a fetch failed…), shown on the card; null once one succeeds. */
  conflictCheckError: string | null;
  /** Set while the task's next agent stage waits for a free slot (the run cap); null when running or resting. */
  queuedAt: string | null;
  /** The instructions a queued stage will run with (a request-changes note, reviewer comments) — kept on
   *  the task while it waits, so a restart can't start it without them. Null otherwise. */
  queuedNote: { text: string; trusted: boolean } | null;
  /** Why a queued task is held rather than waiting for a slot — the daily spending limit (spec 2026-10-09 §6.4). */
  queuedReason: string | null;
  /** The last status move on the tracker that failed (shown on the card); cleared by the next success. */
  trackerSyncError: string | null;
  agentId: string;
  stage: BugStage;
  gate: { kind: GateKind; openedAt: string; reason?: "feedback" | "rebase" | "external" } | null;
  mergePolicy: "ask" | "auto";
  mergeMethod: "squash" | "merge" | "rebase";
  /** The commit HEAD pointed at when the diff gate opened — i.e. exactly what the human
   *  approved. `opening-pr` refuses to run unless HEAD is still this commit. */
  approvedHead: string | null;
  /**
   * How the task ENDED, set by the server at the moment it knows — "merged" on the transition
   * out of `merging` (which only runs once the forge itself has been re-read and reports
   * MERGED), "closed" on a `pr-closed` ending. Null until then.
   *
   * It exists because both earlier signals were proxies that disagreed: the card classified on
   * `pr.state === "MERGED"` (a view a stale watcher tick could overwrite, and whose write is
   * best-effort) and the notification on matching the error text (which a copy edit would
   * silently reclassify). A merged task and a closed-without-merging one must be distinguishable
   * without reading prose or inferring from a PR view. Records written before this field existed
   * normalise to null in `BugTaskStore.init`.
   */
  outcome: "merged" | "closed" | "no-change" | null;
  /**
   * The PR head a `checks-failed` round was last dispatched at. A failing build, like a
   * CHANGES_REQUESTED decision, STANDS until CI runs again — so the failure alone does not say
   * whether it has been answered, and any later change (a bot comment, an unrelated field move)
   * would otherwise re-fire a round with nothing new in it, which `verify()` then fails for
   * having no new commits.
   *
   * The mechanism deliberately rejected for reviews is exactly right here: a review can arrive
   * without the head moving, but a FIX for failing checks always moves it. So a red build at a
   * head we have already answered is old news, and a red build at any other head — including the
   * first one, where this is null — is not. Records written before this field existed normalise
   * to null in `BugTaskStore.init`.
   */
  checksRoundHead: string | null;
  pr: PrInfo | null;
  /** When `pr` was actually read from the forge (ISO), as opposed to `pr.lastSeenEventAt`,
   *  which is the forge's own `updatedAt` for the pull request. Two things need it: the card's
   *  "Last checked", and `BugTaskStore.patchPr`'s staleness rule — the watcher writes PR views
   *  outside the engine's per-task lock, so a tick whose `getPr` was already in flight must not
   *  be able to land its pre-merge view on top of the merge's own bookkeeping. Records written
   *  before this field existed normalise to null in `BugTaskStore.init`. */
  prCheckedAt: string | null;
  costUsd: number;
  /** Every agent run for this task: which stage, on which model, what it cost (spec 2026-10-09 §6.5). */
  runs: Array<{ stage: BugStage; model: string; costUsd: number; at: string; ok: boolean }>;
  /** A stage that failed its check and was stepped up to a stronger model keeps it (spec 2026-10-09 §6.3). */
  stageModel: Partial<Record<"analyzing" | "implementing" | "opening-pr" | "review-feedback" | "rebase", string>>;
  history: Array<{ stage: BugStage; at: string; note: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Incremented when a review-feedback stage is dispatched. Durable, so a restart cannot
   *  reset a task's budget against the cap. Tasks persisted before this field existed are
   *  normalised to 0 in `BugTaskStore.init` — the one place old records enter the system —
   *  so every consumer here can treat it as an honest `number`. */
  feedbackRounds: number;
  /** Everything the agent stages reported assuming or being unable to decide, oldest first.
   *  Records written before 0.6.0 normalise to [] in `BugTaskStore.init`. */
  assumptions: Assumption[];
  /** Why the last assumptions file could not be used, or null. Cleared by the next clean read. */
  assumptionsProblem: string | null;
  /** The dispatch whose assumptions file was read last — set even when it reported nothing or
   *  wrote no file, so the UI's "new" means "from the latest run", not "from the latest run that
   *  happened to report something". Null for records written before it existed. */
  assumptionsToken: string | null;
}

export type BugEvent =
  | { type: "stage-done" }                       // the stage's assignment finished and verified
  | { type: "stage-failed"; reason: string }
  | { type: "approve" }
  | { type: "request-changes"; text: string }
  | { type: "cancel" }
  | { type: "retry" }
  /** Nothing to change: the human closes at the plan gate, or the change step ended with no commits and a clean tree. */
  | { type: "no-change"; report: string }
  /** `source` says whose words `comments` are, and therefore whether the agent may obey them:
   *  "forge" is reviewer/CI text pulled off the pull request (data, fenced in the prompt);
   *  "operator" is the human at the console typing into this app. The watcher only ever
   *  produces "forge"; `addressComments` produces either, depending on whether the human
   *  supplied the text themselves. */
  | { type: "review-changes-requested"; comments: string; source: "forge" | "operator" }
  /** `headSha` is the PR head the failing build ran against, and the engine records it as
   *  `BugTask.checksRoundHead` when it dispatches the round — that is what stops the same red
   *  build being answered twice. Null when the adapter does not report a head. */
  | { type: "checks-failed"; checks: string; headSha: string | null }
  | { type: "review-approved" }
  /** The branch no longer merges cleanly into its base — from the ConflictWatcher (with the files) or the forge's own flag. */
  | { type: "conflicting"; files?: string[]; base?: string; auto?: boolean }
  /** It merges cleanly again (someone rebased by hand, or the base moved on). */
  | { type: "conflict-cleared" }
  | { type: "pr-closed" }
  | { type: "pr-merged" }
  /** A PR for the task's branch, found on the forge after the task failed while pushing or
   *  opening one — someone opened it outside AgentGrid. `reviewed`: it is at the commit the
   *  human approved here, so it can be watched as-is; otherwise its diff is reviewed first. */
  | { type: "pr-adopted"; number: number; reviewed: boolean };

export interface Transition {
  stage: BugStage;
  /** Set only on the transitions that END a task, and then it is the durable answer to "did
   *  this merge?" — see `BugTask.outcome`. Absent leaves whatever the task already had. */
  outcome?: "merged" | "closed" | "no-change";
  /** Set with the "no-change" outcome — see `BugTask.report`. */
  report?: string;
  gate: { kind: GateKind; openedAt: string; reason?: "feedback" | "rebase" | "external" } | null;
  error: string | null;
  note: string;
  /** Stage the engine must now run an assignment for; null when waiting on a human or resting
   *  (a gate stage), or when a server stage is what's next (the engine runs it, not an agent). */
  run: BugStage | null;
}

/** Stages whose work is done by an agent assignment. */
export const AGENT_STAGES: BugStage[] = ["analyzing", "implementing", "opening-pr", "review-feedback", "rebase"];
/** Stages that are waiting on a human click. */
export const GATE_STAGES: BugStage[] = ["plan-review", "diff-review", "approved", "conflict"];
/** Stages the ENGINE performs itself — no assignment, no agent, no tokens. They still
 *  report stage-done/stage-failed, so failure and retry work exactly as for agent stages. */
export const SERVER_STAGES: BugStage[] = ["pushing", "creating-pr", "merging"];
/** Resting stages the watcher polls. Never an agent stage: two things driving one task is
 *  the bug class Phase 1 spent its Criticals on. */
export const WATCHED_STAGES: BugStage[] = ["monitoring", "approved", "conflict"];
/** Agent stages dispatched to resolve a review round; distinct from the other AGENT_STAGES
 *  because they're the ones a feedback-round budget must count against. */
export const FEEDBACK_AGENT_STAGES: BugStage[] = ["review-feedback", "rebase"];
export const TERMINAL_STAGES: BugStage[] = ["done", "cancelled", "failed"];
/**
 * Stages a startup crash can strand a task in with nothing left to finish it: the
 * AGENT_STAGES (an assignment was dispatched but never reported back), "intake" (the task
 * record was written, but the transition into "analyzing" never landed), and the
 * SERVER_STAGES ("pushing"/"creating-pr"/"merging" — the engine itself was mid-step, with
 * no assignment to report back either). A crash mid-"merging" is the worst place in the
 * whole workflow to have no way out: nothing — not the user, not the server — otherwise
 * knows whether the merge actually landed, and neither `retry` (which requires "failed")
 * nor any other event is legal from a server stage. Recovery fails tasks sitting in any of
 * these so they get a card and a working Retry instead of being silently orphaned.
 * Retrying back into "merging" or "pushing" is safe: `doMerge` re-reads the PR before
 * merging (a merge that already landed short-circuits into a teardown-only pass, never a
 * second `forge.merge` call — see its own comment on the entry-route discriminator, which
 * still resolves to "approved" through the interposed "failed"), and `doPush` re-checks
 * the pin and pushes a branch that may already be pushed, which is a no-op. Retrying back
 * into "creating-pr" is safe for the same shape of reason: `git.push` is a no-op on an
 * already-pushed branch, and `forge.createPr` adopts the PR that already exists for the
 * branch instead of opening a second one (see `doCreatePr`) — so re-entering this stage
 * after a crash can never open a duplicate pull request.
 */
export const RECOVERABLE_STAGES: BugStage[] = ["intake", ...AGENT_STAGES, ...SERVER_STAGES];
