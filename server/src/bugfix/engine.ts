import path from "node:path";
import { Conflict } from "../store/store.js";
import type { Store } from "../store/store.js";
import type { Manager } from "../runner/manager.js";
import type { Assignment } from "../types.js";
import { BugTaskStore } from "./store.js";
import { GitOps, branchName, type DiffResult } from "./git.js";
import { IntegrationsStore } from "./integrations.js";
import type { ForgeAdapter } from "./forge/index.js";
import type { TrackerProvider } from "./tracker.js";
import { renderStagePrompt } from "./prompts.js";
import { nextStage } from "./stages.js";
import { AGENT_STAGES, TERMINAL_STAGES, type BugStage, type BugTask } from "./types.js";

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

  /**
   * Startup recovery: `Manager.recoverOnStart()` already resets any assignment left
   * "working"/"waiting" by an unclean shutdown (and frees the agent), but that alone
   * leaves any bug task that was mid-stage stranded — it's still sitting in an
   * `AGENT_STAGES` stage with nothing left to finish it, and `retry()` only accepts a
   * task that's `failed`. This fails those tasks explicitly, naming the restart, so a
   * human sees why and `retry()` works again.
   *
   * Call once at startup: after `Manager.recoverOnStart()` (so the agent/assignment side
   * is already settled) and before `attach()` starts taking new events.
   */
  async recoverOnStart(): Promise<void> {
    for (const task of this.deps.bugs.list()) {
      if (!AGENT_STAGES.includes(task.stage)) continue;
      await this.deps.bugs.apply(task.id, nextStage(task, { type: "stage-failed", reason: "server restarted while this stage was running" }));
    }
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
    if (event.type === "request-changes") this.pendingNote.set(taskId, event.text);
    let task = await this.deps.bugs.apply(taskId, t);
    await this.settleTerminal(task);
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
    }
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
      await bugs.writeArtifact(task.id, "diff.patch", diff.patch);
      await bugs.writeArtifact(task.id, "diffstat.json", JSON.stringify({ files: diff.files, additions: diff.additions, deletions: diff.deletions }, null, 2));
      return;
    }
    if (task.stage === "opening-pr") {
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
    await this.stopAgent(task);
  }

  private async stopAgent(task: BugTask): Promise<void> {
    const { store, manager } = this.deps;
    const agent = store.getAgent(task.agentId);
    if (agent.state === "working" || agent.state === "waiting") await manager.cancel(task.agentId).catch(() => {});
    else if (agent.state === "done" || agent.state === "failed") await manager.ack(task.agentId).catch(() => {});
  }
}
