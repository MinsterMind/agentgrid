import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PermissionBroker } from "../../src/permissions/broker.js";
import { RulesStore } from "../../src/permissions/rules.js";

let rules: RulesStore; let broker: PermissionBroker; let events: any[];
beforeEach(async () => {
  rules = new RulesStore(await mkdtemp(path.join(tmpdir(), "brk-"))); await rules.load();
  broker = new PermissionBroker(rules); events = []; broker.on("event", e => events.push(e));
});
const req = (command = "npm test") => ({ agentId: "rev@r", source: "terminal" as const, sessionId: "s1", toolName: "Bash", input: { command }, suggestions: [] });

describe("PermissionBroker", () => {
  it("records a request, announces it, and settles it once", async () => {
    const { id, decision } = broker.ask(req());
    expect(broker.list()).toEqual([expect.objectContaining({ id, agentId: "rev@r", toolName: "Bash", suggestedRule: "Bash(npm test:*)", ruleIsBroad: false })]);
    expect(events[0]).toMatchObject({ type: "permission", request: { id } });
    await broker.answer(id, { kind: "allow" });
    expect(await decision).toEqual({ behavior: "allow" });
    expect(broker.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "permission-settled", id });
    // Review Focus 1: the second answer loses
    await expect(broker.answer(id, { kind: "deny" })).rejects.toMatchObject({ status: 409 });
  });
  it("deny carries a message; answers are not a permission decision", async () => {
    const a = broker.ask(req()); await broker.answer(a.id, { kind: "deny" });
    expect(await a.decision).toEqual({ behavior: "deny", message: "Denied in AgentGrid" });
    const b = broker.ask(req()); await expect(broker.answer(b.id, { kind: "answers", answers: {} })).rejects.toMatchObject({ status: 400 });
  });
  it("always saves the suggested rule, and later matching requests are allowed without asking", async () => {
    const a = broker.ask(req("npm test -- -t x")); await broker.answer(a.id, { kind: "always" });
    expect(await a.decision).toEqual({ behavior: "allow" });
    expect(rules.rules()).toEqual(["Bash(npm test:*)"]);
    expect(broker.allowed("Bash", { command: "npm test" })).toBe(true);
    expect(broker.allowed("Bash", { command: "npm test && rm -rf /" })).toBe(false);
  });
  it("cancel and cancelSession settle with null and drop the request", async () => {
    const a = broker.ask(req()); const b = broker.ask({ ...req(), sessionId: "s2" });
    broker.cancelSession("s1");
    expect(await a.decision).toBeNull(); expect(broker.list().map(r => r.id)).toEqual([b.id]);
    broker.cancel(b.id); expect(await b.decision).toBeNull(); expect(broker.list()).toEqual([]);
  });

  // Task 1's spike: answering in the terminal settles Claude Code's prompt but never tells the hook.
  it("reconcile drops a request once the session's log shows its tool moved on", async () => {
    const a = broker.ask(req("npm test"));
    const created = broker.list()[0].createdAt;
    const later = new Date(Date.parse(created) + 1000).toISOString();
    const earlier = new Date(Date.parse(created) - 1000).toISOString();
    const st = (x: object) => ({ sessionId: "s1", phase: "working" as const, lastMessage: "", lastPrompt: "", ...x });
    broker.reconcile(st({ updatedAt: earlier }));                                                   // log older than the request
    broker.reconcile(st({ updatedAt: later, runningTool: { name: "Bash", summary: "npm test" } }));   // still that tool
    broker.reconcile({ ...st({ updatedAt: later }), sessionId: "other" });                            // another session
    expect(broker.list()).toHaveLength(1);
    broker.reconcile(st({ updatedAt: later }));                                                     // tool finished
    expect(await a.decision).toBeNull(); expect(broker.list()).toEqual([]);
  });

  // Final review: the first answer claims the request before it awaits anything (saving a rule).
  it("two answers at once: the first wins, the second is refused, and a losing Always saves nothing", async () => {
    const a = broker.ask(req("ls -la"));
    const first = broker.answer(a.id, { kind: "deny" });
    const second = broker.answer(a.id, { kind: "always" });
    await Promise.all([expect(first).resolves.toBeUndefined(), expect(second).rejects.toMatchObject({ status: 409 })]);
    expect(await a.decision).toEqual({ behavior: "deny", message: "Denied in AgentGrid" });
    expect(rules.rules()).toEqual([]);
    const b = broker.ask(req("ls -la"));
    const win = broker.answer(b.id, { kind: "always" }); const lose = broker.answer(b.id, { kind: "deny" });
    await Promise.all([win, expect(lose).rejects.toMatchObject({ status: 409 })]);
    expect(await b.decision).toEqual({ behavior: "allow" }); expect(rules.rules()).toEqual(["Bash(ls:*)"]);
  });

  // Final review: a subagent's request arrives under the parent session, whose log shows only the Task/Agent call.
  it("reconcile leaves a request alone while the session is running subagents", async () => {
    broker.ask(req("npm test"));
    const later = new Date(Date.parse(broker.list()[0].createdAt) + 1000).toISOString();
    for (const name of ["Task", "Agent"]) broker.reconcile({ sessionId: "s1", phase: "working", lastMessage: "", lastPrompt: "", updatedAt: later, runningTool: { name, summary: "explore" } });
    expect(broker.list()).toHaveLength(1);
  });
});
