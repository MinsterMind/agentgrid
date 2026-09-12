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

  constructor(readonly agentId: string, private deps: { store: Store; queryFn: QueryFn; buildOptions: BuildOptions }) {}

  get busy(): boolean { return this.assignmentId !== null; }

  async assign(prompt: string): Promise<Assignment> {
    const { store } = this.deps;
    const agent = store.getAgent(this.agentId);
    if (agent.state !== "free") throw new Conflict(`agent ${this.agentId} is ${agent.state}`);
    const role = store.getRole(agent.role);
    const assignment = await store.createAssignment({ agentId: this.agentId, prompt });
    this.assignmentId = assignment.id;
    await store.updateAgent(this.agentId, { state: "working", currentAssignmentId: assignment.id });

    const fullPrompt = assemblePrompt({ memoryDir: store.memoryDir(this.agentId), index: await store.readMemoryIndex(this.agentId), task: prompt });
    this.abort = new AbortController();
    const options = this.deps.buildOptions(role, agent, { canUseTool: this.canUseTool, abortController: this.abort });
    void this.consume(this.deps.queryFn({ prompt: fullPrompt, options }), assignment.id);
    return assignment;
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => {
    const toolUseId = opts.toolUseID;
    const pending: Pending = toolName === "AskUserQuestion"
      ? { kind: "question", toolUseId, toolName: "AskUserQuestion", input, suggestions: opts.suggestions ?? [] }
      : { kind: "permission", toolUseId, toolName, input, suggestions: opts.suggestions ?? [] };
    return new Promise<PermissionResult>(resolve => {
      this.parked.set(toolUseId, { pending, resolve });
      void this.patch({ pending, state: "waiting" }, "waiting");
    });
  };

  async answer(toolUseId: string, decision: Decision): Promise<void> {
    const parked = this.parked.get(toolUseId);
    if (!parked) throw new Conflict(`no pending prompt ${toolUseId} on ${this.agentId}`);
    this.parked.delete(toolUseId);
    const { pending } = parked;
    let result: PermissionResult;
    switch (decision.kind) {
      case "allow": result = { behavior: "allow" }; break;
      case "always": result = { behavior: "allow", updatedPermissions: pending.suggestions as any }; break;
      case "deny": result = { behavior: "deny", message: decision.message ?? "denied by user" }; break;
      case "answers": result = { behavior: "allow", updatedInput: { ...pending.input, answers: decision.answers, ...(decision.response ? { response: decision.response } : {}) } }; break;
    }
    await this.patch({ pending: null, state: "working" }, "working");
    parked.resolve(result);
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
      if (this.assignmentId === id) await this.finish({ state: "failed", error: (err as Error).message ?? String(err) });
    }
  }

  private async patch(patch: Partial<Assignment>, agentState?: Agent["state"]): Promise<void> {
    if (!this.assignmentId) return;
    await this.deps.store.updateAssignment(this.assignmentId, patch);
    if (agentState) await this.deps.store.updateAgent(this.agentId, { state: agentState });
  }

  private async finish(patch: Partial<Assignment> & { state: "done" | "failed" }): Promise<void> {
    const id = this.assignmentId; if (!id) return;
    this.assignmentId = null; this.abort = null;
    await this.deps.store.updateAssignment(id, { ...patch, pending: null, endedAt: new Date().toISOString() });
    await this.deps.store.updateAgent(this.agentId, { state: patch.state });
  }
}
