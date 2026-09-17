import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { createApp } from "../src/api/app.js";
import { makeFakeQuery, success, init } from "./helpers/fakeQuery.js";
import { until } from "./helpers/until.js";
import type { Options, CanUseTool } from "@anthropic-ai/claude-agent-sdk";

let app: ReturnType<typeof createApp>; let browseRoot: string; let store: Store; let fake: ReturnType<typeof makeFakeQuery>;
let canUseTool: CanUseTool | undefined;

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  fake = makeFakeQuery();
  const manager = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => { canUseTool = e.canUseTool; return { cwd: a.repo, abortController: e.abortController } as Options; } });
  browseRoot = await realpath(await mkdtemp(path.join(tmpdir(), "browse-")));
  await mkdir(path.join(browseRoot, "repo", ".git"), { recursive: true });
  app = createApp({ store, manager, browseRoot });
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
    await until(() => store.getAgent(agent.id).state === "waiting");
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("waiting");
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "zzz", decision: { kind: "allow" } }).expect(409);
    await request(app).post(`/api/agents/${agent.id}/answer`).send({ toolUseId: "tu-1", decision: { kind: "allow" } }).expect(204);
    expect(await p).toEqual({ behavior: "allow" });

    await request(app).post(`/api/agents/${agent.id}/ack`).expect(409);
    fake.emit(success("fin")); fake.end();
    await until(() => store.getAgent(agent.id).state === "done");
    await request(app).post(`/api/agents/${agent.id}/ack`).expect(204);
    expect((await request(app).get("/api/state")).body.agents[0].state).toBe("free");
  });

  it("cancel → 204 and failed", async () => {
    const { body: agent } = await request(app).post("/api/agents").send({ role: "coder", repo: "/x/hrns" });
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" });
    await request(app).post(`/api/agents/${agent.id}/cancel`).expect(204);
    await until(() => store.getAssignment(asg.id).state === "failed");
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
    const { body: asg } = await request(app).post(`/api/agents/${agent.id}/assign`).send({ prompt: "go" });
    fake.emit(init("sess-1"));
    await until(() => store.getAssignment(asg.id).sessionId === "sess-1");
    const res = await request(app).post(`/api/agents/${agent.id}/open-terminal`).expect(200);
    expect(res.body.command).toBe("cd '/tmp/it'\\''s $(x)' && claude --resume 'sess-1'");
  });
});

describe("GET /api/fs", () => {
  it("lists the browse root by default and descends with ?path", async () => {
    const root = await request(app).get("/api/fs").expect(200);
    expect(root.body).toEqual({ root: browseRoot, path: browseRoot, parent: null, entries: [{ name: "repo", path: path.join(browseRoot, "repo"), isRepo: true }] });
    const sub = await request(app).get("/api/fs").query({ path: path.join(browseRoot, "repo") }).expect(200);
    expect(sub.body.parent).toBe(browseRoot);
  });
  it("400 outside root, 404 missing", async () => {
    await request(app).get("/api/fs").query({ path: "/" }).expect(400);
    await request(app).get("/api/fs").query({ path: path.join(browseRoot, "nope") }).expect(404);
  });
});

describe("POST /api/fs/pick", () => {
  it("returns the chosen path, 204 on cancel, and passes through picker failures", async () => {
    const calls: string[] = [];
    let result: string | null = "/picked/repo";
    const a = createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn }), browseRoot, pickFolder: async d => { calls.push(d); if (result === "boom") throw Object.assign(new Error("boom"), { status: 501 }); return result; } });
    expect((await request(a).post("/api/fs/pick").expect(200)).body).toEqual({ path: "/picked/repo" });
    expect(calls).toEqual([browseRoot]);
    result = null; await request(a).post("/api/fs/pick").expect(204);
    result = "boom"; await request(a).post("/api/fs/pick").expect(501);
  });
});

describe("sessions", () => {
  const live = [{ sessionId: "s-live", cwd: "/x/live", name: "term", kind: "interactive" as const, status: "idle" as const, startedAt: 5 }];
  const history = [{ sessionId: "s-live", cwd: "/x/live", title: "t", lastActiveAt: 1 }, { sessionId: "s-old", cwd: "/x/old", title: "old work", lastActiveAt: 9 }];
  const mk = () => { store.setLiveSessions(live); return createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn }), sessions: { live: async () => live, history: async () => history } }); };

  it("GET /api/sessions merges live + history", async () => {
    const res = await request(mk()).get("/api/sessions").expect(200);
    expect(res.body.map((s: any) => [s.sessionId, s.kind, s.canAdopt])).toEqual([["s-live", "interactive", true], ["s-old", "history", true]]);
    expect((await request(mk()).get("/api/state").expect(200)).body.liveSessions.map((s: any) => s.sessionId)).toEqual(["s-live"]);
  });

  it("attach opens `claude attach <bgId>` for background sessions only", async () => {
    const ran: string[] = [];
    store.setLiveSessions([...live, { sessionId: "s-bg", cwd: "/x/bg", name: "bg", kind: "background" as const, status: "blocked" as const, startedAt: 1, bgId: "d85e" }]);
    const a = createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn }), runInTerminal: async c => { ran.push(c); }, sessions: { live: async () => [], history: async () => [] } });
    expect((await request(a).post("/api/sessions/s-bg/attach").expect(200)).body).toEqual({ command: "claude attach 'd85e'", opened: true });
    expect(ran).toEqual(["claude attach 'd85e'"]);
    await request(a).post("/api/sessions/s-live/attach").expect(400);
    await request(a).post("/api/sessions/nope/attach").expect(404);
  });

  it("adopt creates an agent bound to the session; guards live/duplicate/unknown", async () => {
    const a = mk();
    await request(a).post("/api/sessions/s-old/adopt").send({}).expect(400);
    await request(a).post("/api/sessions/nope/adopt").send({ role: "coder" }).expect(404);
    // live sessions can be pulled in; the tile just can't be assigned while the terminal is open
    const liveAgent = (await request(a).post("/api/sessions/s-live/adopt").send({ role: "coder" }).expect(201)).body;
    expect(liveAgent).toMatchObject({ repo: "/x/live", resumeSessionId: "s-live" });
    expect((await request(a).post(`/api/agents/${liveAgent.id}/assign`).send({ prompt: "x" }).expect(409)).body.error).toMatch(/open in a terminal/);
    expect((await request(a).get("/api/state")).body.liveSessions[0]).toMatchObject({ sessionId: "s-live", agentId: liveAgent.id, canAdopt: false });
    const res = await request(a).post("/api/sessions/s-old/adopt").send({ role: "coder", displayName: "Old" }).expect(201);
    expect(res.body).toMatchObject({ id: "coder@old", repo: "/x/old", resumeSessionId: "s-old", displayName: "Old", state: "free" });
    await request(a).post("/api/sessions/s-old/adopt").send({ role: "reviewer" }).expect(409);
    const list = await request(a).get("/api/sessions").expect(200);
    expect(list.body.find((s: any) => s.sessionId === "s-old")).toMatchObject({ agentId: "coder@old", canAdopt: false });
  });
});

describe("GET /api/agents/:id/transcript", () => {
  it("resolves the session from the current assignment, else resumeSessionId, else last assignment", async () => {
    const seen: string[] = [];
    const a = createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, ag, e) => ({ cwd: ag.repo, abortController: e.abortController }) as Options }),
      fullTranscript: async (_cwd, sid) => { seen.push(sid); return [{ kind: "text", text: `from ${sid}` }]; } });
    const adopted = await store.createAgent({ role: "coder", repo: "/x/one", resumeSessionId: "s-adopted" });
    expect((await request(a).get(`/api/agents/${adopted.id}/transcript`).expect(200)).body).toEqual({ sessionId: "s-adopted", entries: [{ kind: "text", text: "from s-adopted" }] });
    const fresh = await store.createAgent({ role: "coder", repo: "/x/two" });
    expect((await request(a).get(`/api/agents/${fresh.id}/transcript`).expect(200)).body).toEqual({ sessionId: null, entries: [] });
    const { body: asg } = await request(a).post(`/api/agents/${fresh.id}/assign`).send({ prompt: "go" }).expect(201);
    fake.emit(init("s-run")); await until(() => store.getAssignment(asg.id).sessionId === "s-run");
    expect((await request(a).get(`/api/agents/${fresh.id}/transcript`).expect(200)).body.sessionId).toBe("s-run");
    fake.emit(success("done")); fake.end(); await until(() => store.getAgent(fresh.id).state === "done");
    await request(a).post(`/api/agents/${fresh.id}/ack`).expect(204);
    expect((await request(a).get(`/api/agents/${fresh.id}/transcript`).expect(200)).body.sessionId).toBe("s-run"); // last assignment
    await request(a).get("/api/agents/nope/transcript").expect(404);
  });
});

describe("adopt with takeover", () => {
  it("closes the terminal session, refreshes live list, then adopts", async () => {
    let list = [{ sessionId: "s-tty", cwd: "/x/tty", name: "tty", kind: "interactive" as const, status: "idle" as const, startedAt: 1, pid: 777 }];
    const killed: number[] = [];
    store.setLiveSessions(list);
    const a = createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn }), killSession: pid => { killed.push(pid); list = []; }, sessions: { live: async () => list, history: async () => [] } });
    const res = await request(a).post("/api/sessions/s-tty/adopt").send({ role: "coder", takeover: true }).expect(201);
    expect(killed).toEqual([777]);
    expect(res.body).toMatchObject({ resumeSessionId: "s-tty", repo: "/x/tty" });
    expect(store.isLive("s-tty")).toBe(false);
    // and now the embedded terminal may resume it
    await request(a).post(`/api/agents/${res.body.id}/assign`).send({ prompt: "x" }).expect(201);
  });
  it("without takeover a live terminal session is adopted but stays live", async () => {
    store.setLiveSessions([{ sessionId: "s-tty", cwd: "/x/tty", name: "tty", kind: "interactive" as const, status: "idle" as const, startedAt: 1, pid: 777 }]);
    const a = createApp({ store, manager: new Manager(store, { queryFn: fake.queryFn }), killSession: () => { throw new Error("should not kill"); }, sessions: { live: async () => store.rawLiveSessions(), history: async () => [] } });
    await request(a).post("/api/sessions/s-tty/adopt").send({ role: "coder" }).expect(201);
    expect(store.isLive("s-tty")).toBe(true);
  });
});
