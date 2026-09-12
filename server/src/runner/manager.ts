import { Store } from "../store/store.js";
import { Runner, type BuildOptions, type QueryFn } from "./runner.js";
import { buildOptions as defaultBuildOptions, realQuery } from "./sdk.js";
import type { Assignment, Decision } from "../types.js";

export class Manager {
  private runners = new Map<string, Runner>();
  private queryFn: QueryFn; private buildOptions: BuildOptions;

  constructor(private store: Store, deps: { queryFn?: QueryFn; buildOptions?: BuildOptions } = {}) {
    this.queryFn = deps.queryFn ?? realQuery;
    this.buildOptions = deps.buildOptions ?? defaultBuildOptions;
  }

  private runner(agentId: string): Runner {
    this.store.getAgent(agentId); // throws NotFound
    let r = this.runners.get(agentId);
    if (!r) { r = new Runner(agentId, { store: this.store, queryFn: this.queryFn, buildOptions: this.buildOptions }); this.runners.set(agentId, r); }
    return r;
  }

  async recoverOnStart(): Promise<void> {
    for (const a of this.store.listAssignments(Number.MAX_SAFE_INTEGER)) {
      if (a.state === "working" || a.state === "waiting") {
        await this.store.updateAssignment(a.id, { state: "failed", error: "server restarted", pending: null, endedAt: new Date().toISOString() });
      }
    }
    for (const ag of this.store.listAgents()) {
      if (ag.state !== "free") await this.store.updateAgent(ag.id, { state: "free", currentAssignmentId: null });
    }
  }

  async assign(agentId: string, prompt: string): Promise<Assignment> { return this.runner(agentId).assign(prompt); }
  async answer(agentId: string, toolUseId: string, decision: Decision): Promise<void> { return this.runner(agentId).answer(toolUseId, decision); }
  async cancel(agentId: string): Promise<void> { return this.runner(agentId).cancel(); }
  async ack(agentId: string): Promise<void> { return this.runner(agentId).ack(); }

  async archive(agentId: string): Promise<void> {
    const r = this.runner(agentId);
    if (r.busy) await r.cancel();
    this.runners.delete(agentId);
    await this.store.archiveAgent(agentId);
  }
}
