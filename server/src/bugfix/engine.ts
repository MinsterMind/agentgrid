import path from "node:path";
import { stat } from "node:fs/promises";
import { Conflict, NotFound } from "../store/store.js";
import type { Store } from "../store/store.js";
import type { Manager } from "../runner/manager.js";
import type { Assignment } from "../types.js";
import { BugTaskStore } from "./store.js";
import { GitOps, branchName, worktreePath, type DiffResult } from "./git.js";
import { IntegrationsStore } from "./integrations.js";
import type { ForgeAdapter } from "./forge/index.js";
import type { TrackerProvider } from "./tracker.js";
import { renderStagePrompt } from "./prompts.js";
import { nextStage } from "./stages.js";
import { AGENT_STAGES, RECOVERABLE_STAGES, SERVER_STAGES, TERMINAL_STAGES, type BugEvent, type BugStage, type BugTask } from "./types.js";
import { describeComments, type PrFinding } from "./watcher.js";
import type { MergeMethod } from "./forge/types.js";

/** After this many rounds the watcher's findings stop dispatching and only report. A
 *  pathological review thread should not quietly spend the user's budget. */
export const FEEDBACK_ROUND_CAP = 5;

/** Prefix of the "the forge could not be read" note. One constant because three places have to
 *  agree on it: the write, the clear once a poll succeeds again, and the card that renders it. */
export const UNREACHABLE = "could not check the pull request:";

/**
 * Every watcher event type that routes to `review-feedback` (see `nextStage`'s
 * "review-changes-requested"/"checks-failed" cases in stages.ts). The cap in `onPrFinding`
 * applies to this whole set, not to one member of it: it exists to stop the *watcher* from
 * spending the user's budget unattended, and that purpose doesn't care which kind of finding
 * is what keeps re-triggering a round — a PR whose CI keeps failing burns exactly as much
 * agent time per round as one whose reviewers keep asking for changes.
 */
const REVIEW_FEEDBACK_EVENTS: ReadonlySet<BugEvent["type"]> = new Set(["review-changes-requested", "checks-failed"]);

/**
 * Startup recovery. Needs only the bug store — no tracker, forge, manager or
 * `BugFixEngine` — so `start.ts` calls it directly and unconditionally, right after the
 * bug store initialises and before any `BugFixEngine` is even built (there may not be
 * one, if no tracker is configured). Call it after `Manager.recoverOnStart()` (so the
 * agent/assignment side is already settled).
 *
 * Fails any task left in `RECOVERABLE_STAGES` by an unclean shutdown, naming the
 * restart, so it gets a card and a working Retry instead of being orphaned.
 */
export async function recoverStuckBugTasks(bugs: BugTaskStore): Promise<void> {
  for (const task of bugs.list()) {
    if (!RECOVERABLE_STAGES.includes(task.stage)) continue;
    await bugs.apply(task.id, nextStage(task, { type: "stage-failed", reason: "server restarted while this stage was running" }));
  }
}

export interface EngineDeps {
  store: Store; bugs: BugTaskStore; manager: Manager; git: GitOps;
  integrations: IntegrationsStore; tracker: TrackerProvider; forge: ForgeAdapter | null;
  presetsDir: string; role?: string;
}

/**
 * Drives bug tasks: turns each stage into one assignment on the task's agent, verifies
 * the result itself, and hands control back to the human at every gate.
 */
export class BugFixEngine {
  readonly deps: EngineDeps;
  private role: string;
  /** Notes from a "request changes" gate, consumed by the next render. */
  private pendingNote = new Map<string, string>();
  /** Guards `attach()` against registering a second listener on a repeat call. */
  private attached = false;
  /**
   * Serialises `advance()` per task id, the same shape `withWriteChain` in
   * integrations.ts uses. Two calls that touch the same task (a double-clicked Approve,
   * or a click racing the agent's own completion event) must not both read the same
   * pre-transition snapshot and pass a gate check meant to admit only one of them; each
   * call now waits for the previous one for that task to fully settle, then re-reads the
   * task from scratch before computing its own transition. Entries are dropped once they
   * settle so this map never grows unbounded.
   */
  private taskChains = new Map<string, Promise<unknown>>();
  /**
   * taskId -> the id of the assignment this *instance* most recently dispatched for it.
   * Set synchronously in `runStage`, the instant `manager.assign()` resolves — no
   * `await` between that and the write. That ordering matters: an assignment that fails
   * on its *first stream iteration* (spawn ENOENT, a bad cwd, an immediate abort, or
   * runner.ts's own "stream ended without result") resolves `manager.assign()`
   * successfully (state "working") and only fails later, asynchronously, once Runner's
   * background consume() loop actually iterates the stream — but reaching that failure
   * still requires strictly more of Runner's own sequential store writes than
   * `manager.assign()` itself needed to resolve, so this in-memory write reliably lands
   * first. Assignments that died *before* the write (cancelled inside `assign()`, or a
   * synchronously-throwing queryFn) are caught by `runStage`'s re-read of the store
   * immediately after it — so between the two, no assignment event for a task this
   * engine is dispatching can be missed, however that assignment dies.
   *
   * Keyed by task id rather than by assignment id, so it doubles as "the *latest*
   * assignment I dispatched for this task" — which is what correctly ignores a stale
   * duplicate event from an *earlier* assignment for the same task. `attach()` listens
   * on the shared store's event bus, which any number of BugFixEngine instances may
   * also be listening on (deliberately, in tests exercising this; in principle also
   * transiently in production) — this map is what keeps a non-dispatching instance from
   * reacting to another instance's event: it simply has no entry for that task. Entries
   * are dropped once the task reaches a terminal stage (`settleTerminal`), where there
   * is nothing left for an event to advance. That is not a self-emptying map: in
   * Phase 1 `nextStage` never returns `done`, and the successful terminus is
   * `monitoring`, which is not terminal — so a task that goes well keeps its entry for
   * as long as it lives. That is intended (one entry per live task, which Phase 2's
   * monitoring/merge stages will dispatch against), not a leak.
   */
  private currentDispatch = new Map<string, string>();

  constructor(deps: EngineDeps) { this.deps = deps; this.role = deps.role ?? "bugfix"; }

  /** React to assignments finishing; safe to call more than once — a repeat call is a no-op. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.deps.store.on("event", e => {
      if (e?.type !== "assignment") return;
      const a = e.assignment as Assignment;
      if (a.state !== "done" && a.state !== "failed") return;
      void this.onAssignmentFinished(a).catch(err => console.error("[bugfix] stage handling failed", err));
    });
  }

  async preflight(repo: string): Promise<{ ok: boolean; problems: string[] }> {
    const problems: string[] = [];
    if (!(await this.deps.git.hasRemote(repo))) problems.push("this repo has no `origin` remote");
    if (!this.deps.forge) problems.push("no forge configured — PR creation and tracking are unavailable");
    else {
      const auth = await this.deps.forge.authStatus();
      if (!auth.ok) problems.push(`forge not authenticated: ${auth.message}`);
    }
    try { this.deps.store.getRole(this.role); } catch { problems.push(`role "${this.role}" is missing from ~/.agentgrid/roles`); }
    return { ok: problems.length === 0, problems };
  }

  async intake(input: { issueRef: string; repo: string; mergePolicy?: "ask" | "auto"; mergeMethod?: "squash" | "merge" | "rebase" }): Promise<BugTask> {
    const { git, bugs, store, tracker, integrations, forge } = this.deps;
    // Without a pollable forge, `opening-pr` can never be verified (see `verify`), so a
    // gitlab/custom repo would otherwise burn two agent stages and a human gate before
    // failing at the very end — and `retry()` would then just re-run `opening-pr`
    // forever. Refuse up front instead, in the same style as the missing-remote check.
    if (!forge) throw new Conflict("no forge configured — this workflow needs one to open and verify pull requests");
    if (!(await git.hasRemote(input.repo))) throw new Conflict("this repo has no `origin` remote");

    const issue = await tracker.fetchIssue(input.issueRef);
    const branch = branchName(issue.key);
    const baseBranch = await git.defaultBranch(input.repo);
    if (branch === baseBranch) throw new Conflict(`refusing to work on the default branch (${baseBranch})`);

    // A cancelled task deliberately leaves its worktree and branch in place (spec §8) — a
    // leftover worktree may hold unpushed work, so nothing here is ever auto-deleted. But
    // without this check, re-launching the same ticket fails deep inside `git worktree add
    // -b` with a raw "branch already exists" error and no way out. Catch it up front and
    // say exactly what to run.
    //
    // A leftover worktree can be in one of two states git itself disagrees about: still
    // *registered* (the normal case — `git worktree remove` works), or a directory that
    // exists on disk but that `git worktree list` doesn't know about any more (e.g. the
    // `.git/worktrees` metadata was pruned or lost some other way). `git worktree remove`
    // refuses the latter with "is not a working tree" — printing it as the fix would hand
    // the user a command that itself fails, reconstructing the exact wedge this check
    // exists to close. Stat the directory directly so each shape gets a remediation that
    // actually works.
    const leftoverDir = worktreePath(input.repo, issue.key);
    const [worktreeRegistered, dirExists, branchLeftover] = await Promise.all([
      git.worktreeRegistered(input.repo, leftoverDir),
      stat(leftoverDir).then(() => true, () => false),
      git.branchExists(input.repo, branch),
    ]);
    if (worktreeRegistered || dirExists || branchLeftover) {
      const steps: string[] = [];
      if (worktreeRegistered) steps.push(`git -C ${input.repo} worktree remove --force ${leftoverDir}`);
      else if (dirExists) steps.push(`rm -rf ${leftoverDir}`);
      if (branchLeftover) steps.push(`git -C ${input.repo} branch -D ${branch}`);
      const dirNote = !worktreeRegistered && dirExists ? " (present on disk but not registered with git)" : "";
      throw new Conflict(
        `a worktree and/or branch for ${issue.key} already exist from an earlier run — worktree ${leftoverDir}${dirNote}, branch ${branch}. ` +
        `Nothing is removed automatically (the worktree may hold unpushed work). To clear ${steps.length > 1 ? "them" : "it"} and try again, run:\n` +
        steps.map(s => `  ${s}`).join("\n")
      );
    }

    const worktree = await git.createWorktree(input.repo, branch, baseBranch);
    const agent = await store.createAgent({ role: this.role, repo: worktree, displayName: issue.key });
    const project = issue.key.split("-")[0] ?? issue.key;
    await integrations.rememberRepo(project, input.repo);

    const task = await bugs.create({
      issue, trackerProject: project, sourceRepo: input.repo, worktree,
      branch, baseBranch, agentId: agent.id,
      mergePolicy: input.mergePolicy ?? "ask", mergeMethod: input.mergeMethod ?? "squash",
    });
    return this.advance(task.id, { type: "stage-done" });
  }

  approve(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "approve" }); }
  cancel(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "cancel" }); }
  retry(taskId: string): Promise<BugTask> { return this.advance(taskId, { type: "retry" }); }

  /** The merge gate's approve. When a method is chosen at the gate, it's recorded before the
   *  transition runs, so `doMerge` reads the one the human actually picked, not the task's
   *  default from intake — but only once the task is actually sitting at the merge gate. The
   *  same principle as `requestChanges`'s own note (see its comment): a call that turns out
   *  not to be valid here (`approve` below will throw for it) must not leave a method choice
   *  behind for whatever the next successful transition happens to be. */
  async mergeTask(taskId: string, method?: MergeMethod): Promise<BugTask> {
    if (method && this.deps.bugs.get(taskId).stage === "approved") {
      await this.deps.bugs.patch(taskId, { mergeMethod: method });
    }
    return this.approve(taskId);
  }

  /** Removes a finished task and its agent. Refused while the task is still live — dismissing
   *  a running task would strand its agent mid-assignment with nothing left to ack it. */
  async dismiss(taskId: string): Promise<void> {
    const task = this.deps.bugs.get(taskId);
    if (!TERMINAL_STAGES.includes(task.stage)) throw new Conflict(`task ${taskId} is still running (${task.stage})`);
    // Only "already archived" (NotFound, from archiveAgent's own `getAgent` guard) is fine to
    // swallow here — a genuine failure (e.g. EPERM renaming the agent directory) must not be
    // silently eaten, or it orphans the agent directory with nothing left to report it.
    await this.deps.store.archiveAgent(task.agentId).catch(err => { if (!(err instanceof NotFound)) throw err; });
    this.currentDispatch.delete(task.id);
    await this.deps.bugs.remove(task.id);
  }

  /**
   * A feedback round the user asked for, from the monitoring card. It deliberately ignores
   * FEEDBACK_ROUND_CAP: the cap exists to stop the *watcher* spending money unattended, and a
   * human clicking the button is the opposite of unattended. Routes through the same
   * "review-changes-requested" transition a watcher finding would (`nextStage` only accepts
   * that event while "monitoring", so this is refused anywhere else, same as a watcher's own
   * finding would be).
   */
  async addressComments(taskId: string, text?: string): Promise<BugTask> {
    const task = this.deps.bugs.get(taskId);
    const trimmed = text?.trim();
    // The human's own words are the operator speaking; anything read back off the pull request
    // is forge text, whoever asked for it to be fetched.
    const comments = trimmed || (await this.recentComments(task));
    return this.advance(taskId, { type: "review-changes-requested", comments, source: trimmed ? "operator" : "forge" });
  }

  /** Comments the click itself didn't supply: read fresh from the forge since the PR's last
   *  seen event, and render them the same way the watcher's own `decide()` does (via the
   *  shared `describeComments`) — so a manual round reads no differently from an automatic
   *  one. Falls back to a short, generic note rather than failing the click when the forge
   *  can't be read: a human pressing "address these" is not asking for a network diagnostic. */
  private async recentComments(task: BugTask): Promise<string> {
    const { forge } = this.deps;
    if (!forge || !task.pr) return "see the pull request";
    try {
      const events = await forge.listReviewEvents(task.sourceRepo, task.pr.number, task.pr.lastSeenEventAt);
      return describeComments(events) || "see the pull request";
    } catch {
      return "see the pull request";
    }
  }

  async requestChanges(taskId: string, text: string): Promise<BugTask> {
    if (!text.trim()) throw new Conflict("say what should change");
    // The note is stored inside `advanceLocked`, only once the transition itself has
    // been accepted — not here. Storing it up front, before the task is even known to
    // be at a gate, let a rejected request-changes call (wrong stage, or the loser of a
    // race against `approve`) leave its note behind for whatever the *next* successful
    // stage dispatch turned out to be, appearing as a reviewer note on a stage no
    // reviewer commented on.
    return this.advance(taskId, { type: "request-changes", text: text.trim() });
  }

  /**
   * Apply a watcher finding. The watcher never writes task state; this is where its findings
   * become transitions, under the same per-task lock as every other mutation.
   */
  async onPrFinding(f: PrFinding): Promise<void> {
    const task = this.deps.bugs.get(f.taskId);
    // Nothing was read, so there is no fresher view to record — `f.pr` on this path is the LAST
    // KNOWN view echoed back, and writing it would advance `prCheckedAt` to a moment at which
    // the forge was in fact unreadable, making the card's "Last checked" claim a poll that
    // failed.
    if (f.unavailable) { await this.deps.bugs.patch(task.id, { error: `${UNREACHABLE} ${f.unavailable}` }); return; }
    // `patchPr`, not `patch`: this write happens outside `advance()`'s per-task chain, and
    // `approved` is a watched stage — see `BugTaskStore.patchPr` for the staleness rule and the
    // race it exists to lose safely.
    if (f.pr) await this.deps.bugs.patchPr(task.id, f.pr, f.checkedAt ?? new Date().toISOString());
    if (!f.event) return;
    if (REVIEW_FEEDBACK_EVENTS.has(f.event.type) && task.feedbackRounds >= FEEDBACK_ROUND_CAP) {
      await this.deps.bugs.patch(task.id, { error: `this task has hit ${task.feedbackRounds} feedback rounds; AgentGrid has stopped dispatching after ${FEEDBACK_ROUND_CAP} feedback rounds — use "Ask the agent to address these" to continue` });
      return;
    }
    await this.advance(task.id, f.event);
  }

  async diffFor(taskId: string): Promise<DiffResult> {
    const t = this.deps.bugs.get(taskId);
    return this.deps.git.diff(t.worktree, t.baseBranch);
  }

  /** Queue a transition for this task behind whatever is already running for it. */
  private advance(taskId: string, event: Parameters<typeof nextStage>[1]): Promise<BugTask> {
    const prev = this.taskChains.get(taskId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.advanceLocked(taskId, event));
    this.taskChains.set(taskId, run);
    run.finally(() => { if (this.taskChains.get(taskId) === run) this.taskChains.delete(taskId); }).catch(() => {});
    return run;
  }

  /** The actual transition. Only ever runs with exclusive access to `taskId`, granted by
   *  `advance`'s chain — always re-reads the task fresh, so it acts on the real current
   *  state rather than a snapshot that might already be stale by the time it's this
   *  call's turn. */
  private async advanceLocked(taskId: string, event: Parameters<typeof nextStage>[1]): Promise<BugTask> {
    const current = this.deps.bugs.get(taskId);
    const t = nextStage(current, event); // throws for an invalid transition — nothing below runs, including storing a note
    // These three event types all carry the text a review-feedback (or rebase) dispatch must
    // see as its `note` — a human's own request-changes text, a reviewer's forge comments, or
    // a checks failure — the same way `request-changes` already did before Phase 2.
    if (event.type === "request-changes") this.pendingNote.set(taskId, event.text);
    if (event.type === "review-changes-requested") this.pendingNote.set(taskId, event.comments);
    if (event.type === "checks-failed") this.pendingNote.set(taskId, event.checks);
    let task = await this.deps.bugs.apply(taskId, t);
    await this.settleTerminal(task);
    // A server stage is work the engine does itself: no assignment, no agent, no tokens. It
    // still reports stage-done/stage-failed, so failure and retry behave exactly as for an
    // agent stage. Fire it detached — it calls back into `advance`, which would deadlock on
    // this task's own chain link if awaited here (the same reason `onAssignmentFinished` is
    // detached from the store's event listener rather than awaited there).
    if (SERVER_STAGES.includes(task.stage)) { void this.runServerStage(task); return task; }
    if (!t.run) return task;
    try {
      task = await this.runStage(task, t.run);
    } catch (err) {
      const original = err as Error;
      try {
        // Re-read rather than reusing the (possibly now-stale) `task` above: something
        // else may have moved this task on while `runStage` was in flight.
        const freshCurrent = this.deps.bugs.get(taskId);
        task = await this.deps.bugs.apply(taskId, nextStage(freshCurrent, { type: "stage-failed", reason: original.message }));
        // Same cleanup the accepted-transition path above gets: a stage that failed *at
        // dispatch* (e.g. its assignment was cancelled mid-`assign()`) must not leave
        // the agent parked in "failed" waiting for some later retry's ack to free it.
        await this.settleTerminal(task);
      } catch {
        // The task went terminal (e.g. cancelled) underneath this attempt — we can't
        // record our failure over that, but the *original* problem is still the useful
        // thing to surface, not stages.ts's confusing "already terminal" message.
        throw original;
      }
    }
    return task;
  }

  private async runStage(task: BugTask, stage: BugStage): Promise<BugTask> {
    const { bugs, store, manager, forge } = this.deps;
    const dir = bugs.dir(task.id);
    const ctx = {
      artifactsDir: dir, planPath: path.join(dir, "plan.md"), prBodyPath: path.join(dir, "pr-body.md"),
      note: this.pendingNote.get(task.id),
      createPrCommand: stage === "opening-pr" && forge
        ? forge.createPrCommand({ title: `${task.issue.key}: ${task.issue.title}`, bodyFile: path.join(dir, "pr-body.md"), base: task.baseBranch, head: task.branch })
        : undefined,
    };
    if (stage === "opening-pr") {
      // Guard the only stage that touches the outside world.
      if (!forge) throw new Error("no forge configured — cannot open a pull request");
      if (task.branch === task.baseBranch) throw new Error(`refusing to push the default branch (${task.baseBranch})`);
      if ((await this.deps.git.commitsAhead(task.worktree, task.baseBranch)) === 0) throw new Error("no commits to open a pull request with");
      // The human approved a specific commit at the diff gate. If the agent amended or added
      // one since, the PR would contain code nobody reviewed — and the old branch/commits-ahead
      // checks would have waved it through. Fail loudly, naming both commits.
      if (!task.approvedHead) throw new Error("no approved commit recorded for this task — re-run the implement stage so the diff can be reviewed again");
      const head = await this.deps.git.revParse(task.worktree);
      if (head !== task.approvedHead) {
        throw new Error(`the branch moved since the diff was approved: approved ${task.approvedHead}, HEAD is now ${head}. Review the new diff (request changes, then approve again) before opening a pull request.`);
      }
    }
    // A restart cannot reset a task's feedback-round budget against the cap (`feedbackRounds`
    // is durable), so this has to land before dispatch, not after — a stage that failed after
    // dispatching still counts as one round spent, not a free retry of the cap itself.
    if (stage === "review-feedback") await this.deps.bugs.patch(task.id, { feedbackRounds: task.feedbackRounds + 1 });
    const prompt = await renderStagePrompt(stage, task, ctx, this.deps.presetsDir);
    this.pendingNote.delete(task.id);

    const agent = store.getAgent(task.agentId);
    if (agent.state !== "free") await manager.ack(task.agentId).catch(() => {});
    const assignment = await manager.assign(task.agentId, prompt);
    // Runner.assign() handles a synchronously-throwing queryFn (e.g. no Claude Code
    // executable on PATH) by calling its own finish({state:"failed"}) *before*
    // assign() returns — so the "assignment" event for it fires, and is seen by
    // `onAssignmentFinished`, before we get control back here to record ownership
    // below. That event is correctly dropped (we don't own it yet), but the failure
    // itself must not be: `assignment` already carries the terminal state and error,
    // so surface it directly rather than relying on an event that already came and
    // went. This throw is caught by `advanceLocked`, which fails the task exactly as
    // it would for any other stage failure.
    if (assignment.state === "failed") throw new Error(assignment.error ?? "the agent's run failed to start");
    // Synchronous — no `await` before this line since `assignment` resolved, so no
    // event for it can possibly have fired yet (see this field's own comment for why
    // that ordering is guaranteed, not just likely).
    this.currentDispatch.set(task.id, assignment.id);
    // ...but an assignment can also have died *before* that line, in a window the
    // ordering argument above doesn't cover: `Runner.assign()` sets its own
    // `assignmentId` right after creating the assignment record and then does more
    // awaited I/O (updateAgent, readMemoryIndex) before returning. A `manager.cancel()`
    // landing in that gap — a user pressing stop on the agent card while this stage
    // dispatches, via POST /api/agents/:id/cancel — finishes the assignment and fires
    // its event while we still owned nothing, so that event was dropped; and `assign()`
    // hands back the *pre-failure* snapshot, so the `state === "failed"` guard above
    // sees "working". Re-read the record now that ownership is recorded: any event from
    // here on is ours, and anything that already happened is visible in the store. This
    // makes the ownership map complete rather than merely well-ordered — no assignment
    // event for a task we are dispatching can be dropped, however that assignment dies.
    const settled = store.getAssignment(assignment.id);
    // Only `failed` takes this path. A `done` record here would be a *successful* run,
    // and the map entry written above means its event is ours to handle — so leave it
    // to `onAssignmentFinished`, which verifies the stage's real-world effect before
    // advancing. Throwing on `done` would fail a stage that actually succeeded, and
    // skip verification doing it. (No interleaving reaches `done` here today:
    // `consume()` only starts after `assign()`'s last await, and `finish()`'s first
    // write is awaited fs I/O. This is about which way to be wrong if that changes.)
    if (settled.state === "failed") {
      this.currentDispatch.delete(task.id);
      // Runner.finish() writes the agent's own state in a second store write after the
      // assignment's; waiting for it to land lets `stopAgent` (via advanceLocked's
      // failure path) ack the agent to "free" rather than leaving it "failed" for the
      // next dispatch's own ack to clean up. Hygiene, not correctness — and bounded, so
      // it degrades to the old behaviour if the write is slow.
      await this.waitForAgentState(task.agentId, settled.state);
      throw new Error(settled.error ?? "the agent's run failed before the stage could start");
    }
    return bugs.get(task.id);
  }

  /** Runs a `SERVER_STAGES` stage: no assignment, no agent — the engine does the work itself
   *  and reports stage-done/stage-failed exactly as `onAssignmentFinished` does for an agent
   *  stage, so retry and failure handling behave identically either way. */
  private async runServerStage(task: BugTask): Promise<void> {
    try {
      // "merging"'s cleanup message (if any) has to land *after* the stage-done transition
      // below, not before it: `nextStage`'s "merging" case advances to "done" via `go(...)`,
      // which always writes `error: null` — a patch made before that transition would just be
      // clobbered by it. `doMerge` reports the message back instead of writing it itself.
      let cleanupError: string | null = null;
      if (task.stage === "pushing") await this.doPush(task);
      else if (task.stage === "merging") cleanupError = await this.doMerge(task);
      await this.advance(task.id, { type: "stage-done" });
      if (cleanupError) await this.deps.bugs.patch(task.id, { error: cleanupError });
    } catch (err) {
      await this.advance(task.id, { type: "stage-failed", reason: (err as Error).message }).catch(() => {});
    }
  }

  /** Push the task's branch for an approved feedback or rebase diff. The server acts here,
   *  not an agent: no tokens, no improvisation, just the exact commit the human approved. */
  private async doPush(task: BugTask): Promise<void> {
    const { git, forge, bugs } = this.deps;
    // Re-check the pin against the commit the human approved. The gate could have opened
    // minutes ago; anything that moved HEAD since is unreviewed.
    const head = await git.revParse(task.worktree);
    if (head !== task.approvedHead) {
      throw new Error(`the branch moved since the diff was approved: approved ${task.approvedHead}, HEAD is now ${head}. Review the new diff (request changes, then approve again) before pushing.`);
    }
    // The gate that recorded which round this was is already gone by the time this runs —
    // the transition into "pushing" clears it (`gate: null`) — so read it from the task's own
    // history instead: the most recent entry naming an agent stage. "rebase" means force (a
    // lease, never a bare force — see GitOps.push); "review-feedback" (or nothing found)
    // means a plain push.
    const lastRound = [...task.history].reverse().find(h => h.stage === "review-feedback" || h.stage === "rebase");
    const force = lastRound?.stage === "rebase";
    await git.push(task.worktree, task.branch, { force });
    if (!forge || !task.pr) return;
    // Verify rather than trust: confirm the PR actually carries what was just pushed.
    const readAt = new Date().toISOString();
    const lookup = await forge.getPr(task.sourceRepo, task.pr.number);
    if ("found" in lookup && lookup.found) {
      await bugs.patchPr(task.id, lookup.found, readAt);
      // `headSha` is the server's only proof a push landed (Task 1). An adapter that doesn't
      // report it gives null here — skip the comparison rather than failing on an absence of
      // evidence either way.
      if (lookup.found.headSha && lookup.found.headSha !== head) {
        throw new Error(`the pull request is still on ${lookup.found.headSha} after the push`);
      }
    }
  }

  /** The merge gate's approve, executed server-side. The only irreversible step in the whole
   *  workflow — a merge cannot be undone, and teardown destroys a worktree and a branch — so
   *  everything here is ordered to fail safe: verify before merging, verify again before
   *  tearing anything down, and never let a cleanup problem hide a merge that already happened.
   *
   *  Returns the cleanup message when teardown left something behind, or null when it's
   *  clean — the caller (`runServerStage`) applies it as the task's `error` *after* the
   *  stage-done transition lands, since that transition unconditionally clears `error`. */
  private async doMerge(task: BugTask): Promise<string | null> {
    const { forge, bugs, git, tracker } = this.deps;
    if (!forge) throw new Error("no forge adapter: cannot merge");
    if (!task.pr) throw new Error("no pull request recorded for this task");

    // This stage is reached two ways, and only one of them may actually call `forge.merge`.
    // The merge gate's own `approve` passes through "approved" first (`wait("approved",
    // "merge")`, then `serverRun("merging")` on the next approve) — a human explicitly gated
    // it. The watcher's `pr-merged` finding (see stages.ts) jumps straight from "monitoring"
    // to "merging", with no gate at all: it exists to *confirm* a merge that already happened
    // in the browser, not to request one. Without this distinction, a watcher or adapter that
    // ever misreports a still-open PR as MERGED would cause this server to perform a real
    // merge with no human in the loop and no gate ever opened — the one place this task must
    // not fail open on an irreversible action. So: derive the entry route from history (the
    // same shape `doPush` uses for its force flag) and let only the gated route call merge;
    // the ungated route may only confirm, and must fail the stage — never merge — when the PR
    // doesn't already read MERGED.
    //
    // Skip "failed" as well as "merging": `retry` re-enters "merging" directly (stages.ts's
    // `retry` case resumes a failed SERVER_STAGES stage with `serverRun(last.stage)`), so a
    // gated merge that failed and got retried has "failed" sitting on top of the "approved"
    // that actually gated it — without skipping it too, a retry of a failed *gated* merge
    // would misread as the ungated route and refuse forever, with no way out but merging in
    // the browser or dismissing the task. Skipping both still leaves the ungated route
    // correctly ungated: its nearest non-"merging"/"failed" entry is "monitoring", never
    // "approved", however many retries pile "merging"/"failed" pairs on top of it — and an
    // *older* "approved" from an earlier, since-rejected merge-gate visit stays shadowed by
    // whatever more recent stage (e.g. another "monitoring") sits between it and here.
    const enteredFromGate = [...task.history].reverse().find(h => h.stage !== "merging" && h.stage !== "failed")?.stage === "approved";

    // An externally merged PR arrives here too (pr-merged). Re-read before doing anything:
    // merging something already merged is at best noise and at worst an error we would
    // report as a failure.
    const before = await forge.getPr(task.sourceRepo, task.pr.number);
    // Defence in depth: a forge that ever returned a lookup for the wrong PR and happened to
    // read MERGED would otherwise satisfy `alreadyMerged` and tear down a branch that was
    // never actually merged. Cheap to check, and this is the one path where "cheap" still
    // matters more than "the only adapter here can't currently do this".
    if ("found" in before && before.found && before.found.number !== task.pr.number) {
      throw new Error(`the forge returned pull request #${before.found.number} instead of the expected #${task.pr.number}`);
    }
    const alreadyMerged = "found" in before && before.found?.state === "MERGED";
    if (!alreadyMerged && !enteredFromGate) {
      const seen = "unavailable" in before ? `unavailable: ${before.unavailable}` : "found" in before && before.found ? `still ${before.found.state}` : "not found";
      throw new Error(`the pull request has not merged yet (${seen}) — refusing to merge without a gate approval`);
    }
    if (!alreadyMerged) {
      const res = await forge.merge(task.sourceRepo, task.pr.number, task.mergeMethod);
      if (!res.ok) throw new Error(res.message);
    }

    // Verify rather than trust: the merge call succeeding is not the same as the PR being merged.
    const afterReadAt = new Date().toISOString();
    const after = await forge.getPr(task.sourceRepo, task.pr.number);
    if ("found" in after && after.found && after.found.number !== task.pr.number) {
      throw new Error(`the forge returned pull request #${after.found.number} instead of the expected #${task.pr.number}`);
    }
    if (!("found" in after) || after.found?.state !== "MERGED") {
      throw new Error(`the pull request did not come back merged${"unavailable" in after ? ` (${after.unavailable})` : ""}`);
    }
    // From here on, the merge is a fact. Every remaining step is best-effort: a failure in
    // any one of them must be folded into the cleanup message, never propagate and present a
    // merged task as a failed one. `noteProblem` accumulates them all the same way.
    let cleanup: string | null = null;
    const noteProblem = (msg: string) => { cleanup = cleanup ? `${cleanup} Also: ${msg}` : msg; };

    try {
      await bugs.patchPr(task.id, after.found, afterReadAt);
    } catch (err) {
      noteProblem(`could not record the merged pull request: ${(err as Error).message}`);
    }

    // Only now, with the merge confirmed, is it safe to destroy anything.
    try {
      await git.removeWorktree(task.sourceRepo, task.worktree, task.branch);
    } catch (err) {
      noteProblem(`${(err as Error).message}. Left behind: ${task.worktree} and branch ${task.branch} — clear them with: git -C ${task.sourceRepo} worktree remove --force ${task.worktree} && git -C ${task.sourceRepo} branch -D ${task.branch}`);
    }
    try {
      await this.stopAgent(task);
    } catch (err) {
      noteProblem(`could not free the agent after merging: ${(err as Error).message}`);
    }
    try {
      await tracker.comment(task.issue.key, `Fixed by ${after.found.url} (merged).`);
    } catch { /* the ticket is a courtesy; never fail a merged task over it */ }
    return cleanup;
  }

  /** An assignment finished: verify the stage's real-world effect, then advance or fail. */
  private async onAssignmentFinished(a: Assignment): Promise<void> {
    const { bugs, store, manager } = this.deps;
    const task = bugs.byAgent(a.agentId);
    if (!task || !AGENT_STAGES.includes(task.stage)) return;
    // Only react to the assignment this *instance* most recently dispatched for this
    // task — see `currentDispatch`'s own comment for why this alone is both necessary
    // and sufficient (no separate durable-field check needed).
    if (this.currentDispatch.get(task.id) !== a.id) return;

    await bugs.patch(task.id, { costUsd: Number((task.costUsd + (a.costUsd ?? 0)).toFixed(4)) });
    // The "assignment" event fires as soon as the assignment record itself is written,
    // but Runner.finish() writes the agent's own state (to this same a.state) in a
    // second, separate store write right after — so at this point the agent may still
    // show its pre-finish state for a moment. Acking before that write lands would
    // flip the agent back to "free" only for the still-pending write to clobber it
    // back to "done"/"failed" behind our back. Wait for it to actually land first.
    await this.waitForAgentState(task.agentId, a.state);
    // Carry the session forward so later stages resume the same conversation.
    const agent = store.getAgent(task.agentId);
    if (a.sessionId && !agent.resumeSessionId) await store.updateAgent(task.agentId, { resumeSessionId: a.sessionId });
    await manager.ack(task.agentId).catch(() => {});

    if (a.state === "failed") {
      await this.advance(task.id, { type: "stage-failed", reason: a.error ?? "the agent's run failed" });
      return;
    }
    try {
      await this.verify(bugs.get(task.id));
    } catch (err) {
      await this.advance(task.id, { type: "stage-failed", reason: (err as Error).message });
      return;
    }
    await this.advance(task.id, { type: "stage-done" });
  }

  /** The server's own evidence that a stage really happened. */
  private async verify(task: BugTask): Promise<void> {
    const { bugs, git, forge, tracker } = this.deps;
    if (task.stage === "analyzing") {
      const plan = await bugs.readArtifact(task.id, "plan.md");
      if (!plan?.trim()) throw new Error("the agent did not write plan.md");
      return;
    }
    if (task.stage === "implementing") {
      // The agent may have switched branches or detached HEAD inside the worktree —
      // `commitsAhead`/`diff` would then silently count and diff the wrong thing.
      const branch = await git.currentBranch(task.worktree);
      if (branch !== task.branch) throw new Error(`worktree is on ${branch}, not the task branch ${task.branch}`);
      if ((await git.commitsAhead(task.worktree, task.baseBranch)) === 0) throw new Error("no commits on the task branch");
      const diff = await git.diff(task.worktree, task.baseBranch);
      // Pin what the human is about to approve. The diff card renders a LIVE `git diff`, so
      // without this there is nothing tying the reviewed change to the commit that gets pushed.
      await bugs.patch(task.id, { approvedHead: await git.revParse(task.worktree) });
      await bugs.writeArtifact(task.id, "diff.patch", diff.patch);
      await bugs.writeArtifact(task.id, "diffstat.json", JSON.stringify({ files: diff.files, additions: diff.additions, deletions: diff.deletions }, null, 2));
      return;
    }
    if (task.stage === "review-feedback") {
      // Same branch check as "implementing" — the agent may have switched branches or
      // detached HEAD inside the worktree.
      const branch = await git.currentBranch(task.worktree);
      if (branch !== task.branch) throw new Error(`worktree is on ${branch}, not the task branch ${task.branch}`);
      // "New" means new relative to what the PR already has — commits from the previous round
      // are not evidence this round did anything. `approvedHead` is exactly that reference
      // point: the commit the human last approved, whether at the original diff gate or at the
      // end of an earlier feedback round.
      const head = await git.revParse(task.worktree);
      if (head === task.approvedHead) throw new Error("no new commits addressing the review feedback");
      const diff = await git.diff(task.worktree, task.baseBranch);
      await bugs.patch(task.id, { approvedHead: head });
      await bugs.writeArtifact(task.id, "diff.patch", diff.patch);
      await bugs.writeArtifact(task.id, "diffstat.json", JSON.stringify({ files: diff.files, additions: diff.additions, deletions: diff.deletions }, null, 2));
      return;
    }
    if (task.stage === "rebase") {
      // Same branch check as "implementing"/"review-feedback" — the agent may have switched
      // branches or detached HEAD inside the worktree.
      const branch = await git.currentBranch(task.worktree);
      if (branch !== task.branch) throw new Error(`worktree is on ${branch}, not the task branch ${task.branch}`);
      // The server verifies rather than trusts: a rebase left half-finished, or with
      // conflict markers still standing, must fail the stage rather than reach a human as
      // "ready" — the preset tells the agent to finish and leave `git status` clean, but
      // this is what actually enforces it.
      const state = await git.rebaseState(task.worktree);
      if (state.inProgress) throw new Error(`the rebase is not finished — still conflicted: ${state.conflicted.join(", ") || "unknown files"}`);
      if (state.conflicted.length) throw new Error(`conflicts are unresolved in: ${state.conflicted.join(", ")}`);
      if ((await git.commitsAhead(task.worktree, task.baseBranch)) === 0) throw new Error("nothing left on the branch after the rebase");
      const diff = await git.diff(task.worktree, task.baseBranch);
      // A rebase legitimately moves HEAD — re-pin `approvedHead` to the post-rebase head, or
      // the eventual push's own pin check would fail every real rebase (Task 6's dependency).
      await bugs.patch(task.id, { approvedHead: await git.revParse(task.worktree) });
      await bugs.writeArtifact(task.id, "diff.patch", diff.patch);
      await bugs.writeArtifact(task.id, "diffstat.json", JSON.stringify({ files: diff.files, additions: diff.additions, deletions: diff.deletions }, null, 2));
      return;
    }
    if (task.stage === "opening-pr") {
      // `runStage`'s pin check only runs BEFORE dispatch: it proves HEAD hadn't moved at
      // the moment this stage was launched, not that it stayed put for the run's whole
      // duration. An agent that commits (and pushes) inside the worktree during the run
      // itself moves HEAD after that check already passed — this is "the only stage that
      // touches the outside world" per `runStage`'s own comment, and `open-pr.md` already
      // tells the agent not to change code here, so the server must be what actually
      // checks. Re-assert the pin before trusting anything this stage reports.
      const head = await git.revParse(task.worktree);
      if (head !== task.approvedHead) {
        throw new Error(`the branch moved during opening-pr: approved ${task.approvedHead}, HEAD is now ${head}. Review the new diff (request changes, then approve again) before opening a pull request.`);
      }
      const pr = forge ? await forge.findPr(task.sourceRepo, task.branch) : null;
      if (!pr) throw new Error("no pull request found for this branch");
      // The adapter deliberately falls back to `--state all`, so a reused branch can
      // carry a stale CLOSED or MERGED PR from an earlier round. Only an OPEN PR is
      // evidence this run actually produced a fix worth reviewing; anything else must
      // fail the stage rather than be recorded and rested on.
      if (pr.state !== "OPEN") throw new Error(`pull request #${pr.number} is ${pr.state.toLowerCase()}, not open`);
      await bugs.patch(task.id, { pr });
      await tracker.comment(task.issue.key, `Fix in progress — pull request: ${pr.url}`).catch(() => {});
      return;
    }
  }

  /** Poll briefly for the agent's own state to catch up with the assignment's — see the
   *  race note in onAssignmentFinished. Gives up silently after the timeout; ack() will
   *  then throw its own Conflict if the agent genuinely never got there. */
  private async waitForAgentState(agentId: string, state: string, timeoutMs = 1000): Promise<void> {
    const { store } = this.deps;
    const t0 = Date.now();
    while (store.getAgent(agentId).state !== state) {
      if (Date.now() - t0 > timeoutMs) return;
      await new Promise(r => setTimeout(r, 1));
    }
  }

  /** A task that just reached a terminal stage owns nothing any more: drop its dispatch
   *  entry (a stale one is dead weight, and would have to be matched against forever)
   *  and release its agent. */
  private async settleTerminal(task: BugTask): Promise<void> {
    if (!TERMINAL_STAGES.includes(task.stage)) return;
    this.currentDispatch.delete(task.id);
    // Best-effort, deliberately guarded: the task's transition into a terminal stage has
    // already landed and persisted by the time this runs, so a failure here (`stopAgent`'s
    // own `store.getAgent` throwing when the agent was archived out from under the task) must
    // never make this call's caller believe the transition itself failed. This matters
    // beyond hygiene for "merging" -> "done": `doMerge` already folds a `stopAgent` failure
    // of its own into the cleanup message it returns, but `runServerStage` only applies that
    // message *after* `advance(stage-done)` resolves — and that `advance()` call is exactly
    // what runs this method. An unguarded throw here would reject that `advance()` before the
    // message is ever patched onto the task, silently discarding it even though the merge
    // (and the message) both already happened.
    await this.stopAgent(task).catch(() => {});
  }

  private async stopAgent(task: BugTask): Promise<void> {
    const { store, manager } = this.deps;
    const agent = store.getAgent(task.agentId);
    if (agent.state === "working" || agent.state === "waiting") await manager.cancel(task.agentId).catch(() => {});
    else if (agent.state === "done" || agent.state === "failed") await manager.ack(task.agentId).catch(() => {});
  }
}
