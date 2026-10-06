import { EventEmitter } from "node:events";
import { Conflict, BadRequest } from "../store/store.js";
import { allowedByRules, isBroadRule, suggestRule, type RulesStore } from "./rules.js";
import type { Decision, GridEvent, PermissionRequest } from "../types.js";

export type BrokerDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
interface Open { req: PermissionRequest; resolve: (d: BrokerDecision | null) => void }

/** Every open permission request AgentGrid answers for an embedded terminal session; settles each exactly once. */
export class PermissionBroker extends EventEmitter {
  private open = new Map<string, Open>();
  private next = 1;
  constructor(private rules: RulesStore) { super(); }

  allowed(toolName: string, input: Record<string, unknown>): boolean { return allowedByRules(this.rules.rules(), toolName, input); }

  ask(r: { agentId: string; source: "terminal"; sessionId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] }) {
    const suggestedRule = suggestRule(r.toolName, r.input, r.suggestions);
    const req: PermissionRequest = { id: `pr${this.next++}`, agentId: r.agentId, source: r.source, sessionId: r.sessionId, toolName: r.toolName,
      input: r.input, suggestedRule, ruleIsBroad: isBroadRule(suggestedRule), createdAt: new Date().toISOString() };
    const decision = new Promise<BrokerDecision | null>(resolve => this.open.set(req.id, { req, resolve }));
    this.emit("event", { type: "permission", request: req } satisfies GridEvent);
    return { id: req.id, decision };
  }

  async answer(id: string, d: Decision): Promise<void> {
    const o = this.open.get(id);
    if (!o) throw new Conflict(`permission request ${id} is already settled`);
    if (d.kind === "answers") throw new BadRequest("a permission request takes allow, always or deny");
    if (d.kind === "always") await this.rules.add(o.req.suggestedRule);
    this.settle(id, d.kind === "deny" ? { behavior: "deny", message: d.message ?? "Denied in AgentGrid" } : { behavior: "allow" });
  }

  cancel(id: string): void { if (this.open.has(id)) this.settle(id, null); }
  cancelSession(sessionId: string): void { for (const [id, o] of this.open) if (o.req.sessionId === sessionId) this.settle(id, null); }
  has(id: string): boolean { return this.open.has(id); }
  list(): PermissionRequest[] { return [...this.open.values()].map(o => o.req); }

  private settle(id: string, d: BrokerDecision | null): void {
    const o = this.open.get(id); if (!o) return;
    this.open.delete(id);
    o.resolve(d);
    this.emit("event", { type: "permission-settled", id } satisfies GridEvent);
  }
}
