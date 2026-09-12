import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { createApp } from "../src/api/app.js";
import { makeFakeQuery, success, init } from "./helpers/fakeQuery.js";
import type { Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const tick = () => new Promise(r => setTimeout(r, 5));
let app: ReturnType<typeof createApp>; let store: Store; let fake: ReturnType<typeof makeFakeQuery>;
let canUseTool: CanUseTool | undefined;

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  fake = makeFakeQuery();
  const manager = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => { canUseTool = e.canUseTool; return { cwd: a.repo, abortController: e.abortController } as Options; } });
  app = createApp({ store, manager });
});

describe("API", () => {
  it("GET /api/state returns roles, agents, assignments", async () => {
    const res = await request(app).get("/api/state").expect(200);
    expect(res.body.roles.map((r: any) => r.name)).toContain("coder");
    expect(res.body.agents).toEqual([]);
    expect(res.body.assignments).toEqual([]);
  });

  it("POST /api/agents validates and creates; DELETE archives", async () => {
    await request(app).post("/api/agents").send({ role: "coder" }).expect(400);
    await request(app).post("/api/agents").send({ role: "nope", repo: "/x" }).expect(404);
    const res = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns", displayName: "Cody" }).expect(201);
    expect(res.body).toMatchObject({ id: "coder@hrns", displayName: "Cody", state: "free" });
    await request(app).delete("/api/agents/coder@hrns").expect(204);
    await request(app).get("/api/agents/coder@hrns/memory").expect(404);
  });

  it("assign → answer → ack flow with proper status codes", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    await request(app).post(`/api/agents/${agent.id}/assign`).send({}).expect(400);
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" }).expect(201);
    expect(asg.state).toBe("working");
    await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "again" }).expect(409);

    const p = canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "tu-1" } as any);
    await tick();
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("waiting");
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "zzz", decision: { kind: "allow" } }).expect(409);
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "tu-1", decision: { kind: "allow" } }).expect(204);
    expect(await p).toEqual({ behavior: "allow" });

    await request(app).post(`/api/agents/${agent.id}/ack`).expect(409);
    fake.emit(success("fin")); fake.end(); await tick();
    await request(app).post(`/api/agents/${agent.id}/ack`).expect(204);
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("free");
  });

  it("cancel → 204 and failed", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" });
    await request(app).post(`/api/agents/${agent.id}/cancel`).expect(204);
    await tick();
    expect((await request(app).get("/api/state")).body.assignments.find((a: any) => a.id === asg.id).state).toBe("failed");
    await request(app).post(`/api/agents/${agent.id}/cancel`).expect(409);
  });

  it("GET memory lists files; unknown ids are 404", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    expect((await request(app).get(`/api/agents/${agent.id}/memory`).expect(200)).body).toEqual([]);
    await request(app).get("/api/assignments/a99/transcript").expect(404);
  });

  it("unknown /api routes return JSON 404", async () => {
    const res = await request(app).get("/api/nope").expect(404);
    expect(res.body).toEqual({ error: "not found" });
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("open-terminal quotes the repo and sessionId for POSIX shells", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/tmp/it's $(x)" });
    await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" });
    fake.emit(init("sess-1"));
    await tick();
    const res = await request(app).post(`/api/agents/${agent.id}/open-terminal`).expect(200);
    expect(res.body.command).toBe("cd '/tmp/it'\\''s $(x)' && claude --resume 'sess-1'");
  });
});
