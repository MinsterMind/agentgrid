import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { makeFakeQuery, success } from "./fakeQuery.js";
import { until } from "./until.js";

let store: Store; let fake: ReturnType<typeof makeFakeQuery>; let mgr: Manager; let agentId: string;

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  const a = await store.createAgent({ role: "coder", repo: "/tmp/repo" });
  agentId = a.id;
  fake = makeFakeQuery();
  mgr = new Manager(store, { queryFn: fake.queryFn });
});

describe("makeFakeQuery", () => {
  it("gives each assign() its own stream: emit+end after a prior assign's emit+end still delivers the new result", async () => {
    await mgr.assign(agentId, "one");
    fake.emit(success("done1")); fake.end();
    await until(() => store.getAgent(agentId).state === "done");
    await mgr.ack(agentId);

    await mgr.assign(agentId, "two");
    fake.emit(success("done2")); fake.end();
    await until(() => store.getAgent(agentId).state === "done");
    const asg = store.getAssignment(store.getAgent(agentId).currentAssignmentId!);
    expect(asg.outcome).toBe("done2");
  });
});
