import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, NotFound } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { makeFakeQuery, success } from "./helpers/fakeQuery.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let home: string; let store: Store; let fake: ReturnType<typeof makeFakeQuery>; let mgr: Manager;
const buildOptions = (_r: any, a: any, e: any) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  fake = makeFakeQuery();
  mgr = new Manager(store, { queryFn: fake.queryFn, buildOptions });
});

describe("Manager", () => {
  it("routes assign/ack to a per-agent runner", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await mgr.assign(a.id, "p");
    fake.emit(success("ok")); fake.end(); await tick();
    expect(store.getAssignment(asg.id).state).toBe("done");
    await mgr.ack(a.id);
    expect(store.getAgent(a.id).state).toBe("free");
  });

  it("unknown agent → NotFound", async () => {
    await expect(mgr.assign("ghost", "p")).rejects.toThrow(NotFound);
  });

  it("recoverOnStart fails in-flight assignments and frees agents", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await store.createAssignment({ agentId: a.id, prompt: "p" });
    await store.updateAssignment(asg.id, { state: "waiting", sessionId: "s-keep" });
    await store.updateAgent(a.id, { state: "waiting", currentAssignmentId: asg.id });
    const s2 = new Store(home, path.resolve("roles")); await s2.init();
    const m2 = new Manager(s2, { queryFn: fake.queryFn, buildOptions });
    await m2.recoverOnStart();
    expect(s2.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "server restarted", sessionId: "s-keep", pending: null });
    expect(s2.getAgent(a.id)).toMatchObject({ state: "free", currentAssignmentId: null });
  });

  it("archive cancels a running assignment first", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/one" });
    const asg = await mgr.assign(a.id, "p");
    await mgr.archive(a.id); await tick();
    expect(store.getAssignment(asg.id)).toMatchObject({ state: "failed", error: "cancelled" });
    expect(() => store.getAgent(a.id)).toThrow(NotFound);
  });
});
