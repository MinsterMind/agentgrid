import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, Conflict } from "../src/store/store.js";
import { Runner, type BuildOptions } from "../src/runner/runner.js";
import { makeFakeQuery, init, text, toolUse, success, errorResult } from "./helpers/fakeQuery.js";
import type { Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let store: Store; let fake: ReturnType<typeof makeFakeQuery>; let runner: Runner; let agentId: string;
let captured: { canUseTool?: CanUseTool } = {};

const buildOptions: BuildOptions = (role, agent, extra) => {
  captured.canUseTool = extra.canUseTool;
  return { cwd: agent.repo, model: role.model, abortController: extra.abortController, canUseTool: extra.canUseTool } as Options;
};

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  const a = await store.createAgent({ role: "coder", repo: "/tmp/repo" });
  agentId = a.id;
  fake = makeFakeQuery(); captured = {};
  runner = new Runner(agentId, { store, queryFn: fake.queryFn, buildOptions });
});

describe("Runner", () => {
  it("assign: builds prompt with memory index, marks agent working, records sessionId + activity", async () => {
    await writeFile(path.join(store.memoryDir(agentId), "MEMORY.md"), "- [k](k.md) — hook");
    const asg = await runner.assign("Fix the bug");
    expect(store.getAgent(agentId)).toMatchObject({ state: "working", currentAssignmentId: asg.id });
    expect(fake.calls[0].prompt).toContain("- [k](k.md) — hook");
    expect(fake.calls[0].prompt).toContain("<task>\nFix the bug\n</task>");
    expect(fake.calls[0].options.cwd).toBe("/tmp/repo");
    fake.emit(init("sess-1")); fake.emit(text("Looking at src/")); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ sessionId: "sess-1", activity: "Looking at src/", startedAt: expect.any(String) });
    fake.emit(toolUse("Bash", { command: "npm test" })); await tick();
    expect(store.getAssignment(asg.id).activity).toBe("Bash: npm test");
  });

  it("rejects assign when not free", async () => {
    await runner.assign("one");
    await expect(runner.assign("two")).rejects.toThrow(Conflict);
  });

  it("success result → done with outcome/cost/turns; ack → free", async () => {
    const asg = await runner.assign("t");
    fake.emit(success("DONE all good", 1.25, 7)); fake.end(); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "done", outcome: "DONE all good", costUsd: 1.25, turns: 7, endedAt: expect.any(String) });
    expect(store.getAgent(agentId).state).toBe("done");
    await runner.ack();
    expect(store.getAgent(agentId)).toMatchObject({ state: "free", currentAssignmentId: null });
  });

  it("error result → failed with error", async () => {
    const asg = await runner.assign("t");
    fake.emit(errorResult("error_max_turns")); fake.end(); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "error_max_turns" });
    expect(store.getAgent(agentId).state).toBe("failed");
  });

  it("thrown error → failed with message", async () => {
    const asg = await runner.assign("t");
    fake.fail(new Error("boom")); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "boom" });
  });

  it("permission: canUseTool parks → waiting with pending; allow resumes", async () => {
    const asg = await runner.assign("t");
    const p = captured.canUseTool!("Bash", { command: "rm x" }, { signal: new AbortController().signal, toolUseID: "tu-1", suggestions: [{ type: "addRules" }] } as any);
    await tick();
    expect(store.getAgent(agentId).state).toBe("waiting");
    expect(store.getAssignment(asg.id).pending).toEqual({ kind: "permission", toolUseId: "tu-1", toolName: "Bash", input: { command: "rm x" }, suggestions: [{ type: "addRules" }] });
    await runner.answer("tu-1", { kind: "allow" });
    expect(await p).toEqual({ behavior: "allow" });
    expect(store.getAgent(agentId).state).toBe("working");
    expect(store.getAssignment(asg.id).pending).toBeNull();
  });

  it("permission: always → updatedPermissions; deny → deny message", async () => {
    await runner.assign("t");
    const p1 = captured.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-1", suggestions: [{ type: "addRules" }] } as any);
    await tick(); await runner.answer("tu-1", { kind: "always" });
    expect(await p1).toEqual({ behavior: "allow", updatedPermissions: [{ type: "addRules" }] });
    const p2 = captured.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-2" } as any);
    await tick(); await runner.answer("tu-2", { kind: "deny", message: "no" });
    expect(await p2).toEqual({ behavior: "deny", message: "no" });
  });

  it("question: AskUserQuestion → pending.kind question; answers → updatedInput", async () => {
    const asg = await runner.assign("t");
    const input = { questions: [{ question: "Which?", header: "H", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] };
    const p = captured.canUseTool!("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "tu-q" } as any);
    await tick();
    expect(store.getAssignment(asg.id).pending?.kind).toBe("question");
    await runner.answer("tu-q", { kind: "answers", answers: { "Which?": "b" } });
    expect(await p).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which?": "b" } } });
  });

  it("answer with unknown toolUseId → Conflict", async () => {
    await runner.assign("t");
    await expect(runner.answer("nope", { kind: "allow" })).rejects.toThrow(Conflict);
  });

  it("cancel → failed(cancelled), keeps sessionId, aborts query", async () => {
    const asg = await runner.assign("t");
    fake.emit(init("sess-9")); await tick();
    await runner.cancel(); await tick();
    expect(fake.calls[0].options.abortController!.signal.aborted).toBe(true);
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "cancelled", sessionId: "sess-9" });
    expect(store.getAgent(agentId).state).toBe("failed");
  });

  it("cancel while waiting rejects the parked permission", async () => {
    await runner.assign("t");
    const p = captured.canUseTool!("Bash", { command: "x" }, { signal: new AbortController().signal, toolUseID: "tu-1" } as any);
    await tick(); await runner.cancel();
    expect(await p).toEqual({ behavior: "deny", message: "cancelled by user" });
  });

  it("ack when not done/failed → Conflict", async () => {
    await expect(runner.ack()).rejects.toThrow(Conflict);
  });
});
