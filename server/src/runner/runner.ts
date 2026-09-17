import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Store, Conflict } from "../store/store.js";
import { assemblePrompt } from "../prompt/assemble.js";
import type { Agent, Assignment, Decision, Pending, RoleDef } from "../types.js";

export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
export type BuildOptions = (role: RoleDef, agent: Agent, extra: { canUseTool: CanUseTool; abortController: AbortController }) => Options;

interface Parked { pending: Pending; resolve: (r: PermissionResult) => void }

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt ?? input.description ?? "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? `${name}: ${s.slice(0, 120)}` : name;
}

export class Runner {
  private parked = new Map<string, Parked>();
  private abort: AbortController | null = null;
  private assignmentId: string | null = null;
  // Set synchronously at the top of assign(), before any await, and cleared in a
  // `finally` once assign() is done setting up. `agent.state !== "free"` alone isn't
  // enough to prevent a double-assign: it's read synchronously but the agent's state
  // isn't written back to "working" until after several awaits, so two concurrent
  // assign() calls on the same free agent can both pass that check before either
  // writes. This flag closes that window (see review round 2, finding 2).
  private assigning = false;
  // Serializes every store write this Runner makes (patch + finish) so writes for a
  // given assignment always land in call order, never interleaved/raced against
  // each other. See task-6 review round 1, findings 1 & 3.
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly agentId: string, private deps: { store: Store; queryFn: QueryFn; buildOptions: BuildOptions }) {}

  get busy(): boolean { return this.assignmentId !== null; }

  async assign(prompt: string): Promise<Assignment> {
    const { store } = this.deps;
    if (this.assigning) throw new Conflict(`agent ${this.agentId} is being assigned`);
    const agent = store.getAgent(this.agentId);
    if (agent.state !== "free") throw new Conflict(`agent ${this.agentId} is ${agent.state}`);
    if (agent.resumeSessionId && store.isLive(agent.resumeSessionId)) throw new Conflict(`session is open in a terminal — close it (or use the Terminal tab) before assigning`);
    this.assigning = true;
    try {
      const role = store.getRole(agent.role);
      const assignment = await store.createAssignment({ agentId: this.agentId, prompt });
      this.assignmentId = assignment.id;
      await store.updateAgent(this.agentId, { state: "working", currentAssignmentId: assignment.id });

      const fullPrompt = assemblePrompt({ memoryDir: store.memoryDir(this.agentId), index: await store.readMemoryIndex(this.agentId), task: prompt });
      this.abort = new AbortController();
      const options = this.deps.buildOptions(role, agent, { canUseTool: this.canUseTool, abortController: this.abort });
      // Fire-and-forget by design (the stream is consumed in the background), but never
      // bare: any failure that escapes consume()'s own try/catch is logged, not left to
      // become an unhandled rejection that could take down the process.
      void this.consume(this.deps.queryFn({ prompt: fullPrompt, options }), assignment.id).catch(err => {
        console.error(`[runner:${this.agentId}] unexpected consume failure`, err);
      });
      return assignment;
    } finally {
      this.assigning = false;
    }
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => {
    const toolUseId = opts.toolUseID;
    const assignmentId = this.assignmentId;
    const pending: Pending = toolName === "AskUserQuestion"
      ? { kind: "question", toolUseId, toolName: "AskUserQuestion", input, suggestions: opts.suggestions ?? [] }
      : { kind: "permission", toolUseId, toolName, input, suggestions: opts.suggestions ?? [] };
    return new Promise<PermissionResult>(resolve => {
      this.parked.set(toolUseId, { pending, resolve });
      // The parking write is enqueued but not awaited here (canUseTool must return the
      // parked promise synchronously); always guard it with .catch so a write failure
      // can never become an unhandled rejection.
      this.patch({ pending, state: "waiting" }, "waiting").catch(err => this.handleWriteError(err, assignmentId));
    });
  };

  async answer(toolUseId: string, decision: Decision): Promise<void> {
    const parked = this.parked.get(toolUseId);
    if (!parked) throw new Conflict(`no pending prompt ${toolUseId} on ${this.agentId}`);
    const { pending } = parked;
    let result: PermissionResult;
    switch (decision.kind) {
      case "allow": result = { behavior: "allow" }; break;
      case "always": result = { behavior: "allow", updatedPermissions: pending.suggestions as any }; break;
      case "deny": result = { behavior: "deny", message: decision.message ?? "denied by user" }; break;
      case "answers": result = { behavior: "allow", updatedInput: { ...pending.input, answers: decision.answers, ...(decision.response ? { response: decision.response } : {}) } }; break;
    }
    // Resolve the parked SDK promise (and drop the parked entry) in `finally` so the
    // SDK always gets an answer even if the store write throws — previously the entry
    // was deleted and the resolve happened only after `patch` succeeded, so a failed
    // write left the SDK's canUseTool call hanging forever (review round 2, finding 5).
    try {
      await this.patch({ pending: null, state: "working" }, "working");
    } finally {
      this.parked.delete(toolUseId);
      parked.resolve(result);
    }
  }

  async cancel(): Promise<void> {
    if (!this.assignmentId) throw new Conflict(`agent ${this.agentId} has no active assignment`);
    for (const [, p] of this.parked) p.resolve({ behavior: "deny", message: "cancelled by user" });
    this.parked.clear();
    this.abort?.abort();
    await this.finish({ state: "failed", error: "cancelled" });
  }

  async ack(): Promise<void> {
    const agent = this.deps.store.getAgent(this.agentId);
    if (agent.state !== "done" && agent.state !== "failed") throw new Conflict(`agent ${this.agentId} is ${agent.state}`);
    await this.deps.store.updateAgent(this.agentId, { state: "free", currentAssignmentId: null });
  }

  private async consume(stream: AsyncIterable<SDKMessage>, id: string): Promise<void> {
    try {
      for await (const m of stream) {
        if (this.assignmentId !== id) return; // cancelled meanwhile
        if (m.type === "system" && (m as any).subtype === "init") {
          await this.patch({ sessionId: (m as any).session_id, startedAt: new Date().toISOString() });
        } else if (m.type === "assistant") {
          const blocks = (m as any).message?.content ?? [];
          let activity: string | null = null;
          for (const b of blocks) {
            if (b.type === "text" && b.text?.trim()) activity = b.text.trim().slice(0, 160);
            if (b.type === "tool_use") activity = summarizeToolUse(b.name, b.input ?? {});
          }
          if (activity) await this.patch({ activity });
        } else if (m.type === "result") {
          const r = m as any;
          const common = { turns: r.num_turns ?? 0, costUsd: r.total_cost_usd ?? 0 };
          if (r.subtype === "success") await this.finish({ state: "done", outcome: r.result ?? "", ...common });
          else await this.finish({ state: "failed", error: r.subtype, ...common });
          return;
        }
      }
      if (this.assignmentId === id) await this.finish({ state: "failed", error: "stream ended without result" });
    } catch (err) {
      if (this.assignmentId === id) {
        // finish() itself can throw (e.g. the store write fails); that must not escape
        // as an unhandled rejection from this fire-and-forget consume() loop.
        try {
          await this.finish({ state: "failed", error: (err as Error).message ?? String(err) });
        } catch (finishErr) {
          console.error(`[runner:${this.agentId}] failed to record error state after stream failure`, finishErr);
        }
      }
      // else: the assignment already moved on (e.g. cancel() aborted the query) — this
      // error is expected noise from that, not a new failure worth surfacing.
    }
  }

  /** Shared handler for a store write that failed outside of consume()'s own try/catch
   *  (currently: the parking write in canUseTool). Logs and, best-effort, fails the
   *  assignment rather than leaving it stuck or crashing the process. */
  private handleWriteError(err: unknown, assignmentId: string | null): void {
    console.error(`[runner:${this.agentId}] store write failed`, err);
    if (assignmentId && this.assignmentId === assignmentId) {
      this.finish({ state: "failed", error: (err as Error).message ?? String(err) }).catch(finishErr => {
        console.error(`[runner:${this.agentId}] failed to record error state after write failure`, finishErr);
      });
    }
  }

  /** Enqueue an assignment patch. The write is queued on `this.chain` so it can never
   *  interleave with another patch/finish from this Runner (fixes review finding 1),
   *  and the target assignment id is re-checked at the moment the chain actually runs
   *  the write, so a write queued for an assignment that has since ended (cancelled or
   *  finished) is skipped rather than landing after the fact (fixes review finding 3). */
  private patch(patch: Partial<Assignment>, agentState?: Agent["state"]): Promise<void> {
    const id = this.assignmentId;
    if (!id) return Promise.resolve();
    return this.enqueue(async () => {
      if (this.assignmentId !== id) return; // assignment moved on while this write was queued
      await this.deps.store.updateAssignment(id, patch);
      if (agentState) await this.deps.store.updateAgent(this.agentId, { state: agentState });
    });
  }

  /** Finalize the current assignment. `assignmentId` is cleared synchronously (before
   *  the write is even queued) so any patch already queued behind this finish, or any
   *  patch whose write was already in flight when this ran, is recognized as stale by
   *  `patch`'s own re-check and can't undo the terminal state. `activity` is explicitly
   *  cleared so a straggling in-flight patch that lands just before this write can't
   *  leave a "live" activity string on a finished assignment. */
  private finish(patch: Partial<Assignment> & { state: "done" | "failed" }): Promise<void> {
    const id = this.assignmentId;
    if (!id) return Promise.resolve();
    this.assignmentId = null;
    // On the failure path, make sure the SDK subprocess actually stops: previously the
    // AbortController was just dropped (nulled) here without ever firing, so a failure
    // detected from e.g. the result stream (rather than via cancel()) could leave the
    // subprocess running. Harmless to call again if cancel() already aborted it.
    if (patch.state === "failed") this.abort?.abort();
    this.abort = null;
    const endedAt = new Date().toISOString();
    return this.enqueue(async () => {
      await this.deps.store.updateAssignment(id, { activity: "", ...patch, pending: null, endedAt });
      await this.deps.store.updateAgent(this.agentId, { state: patch.state });
    });
  }

  /** Serial write queue: each `fn` runs only after the previous one has settled,
   *  regardless of how long its own store I/O takes. A rejection is returned to the
   *  caller of this particular `enqueue` call but never propagates into `this.chain`
   *  itself (so one failed write can't wedge every future write behind it). */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}
