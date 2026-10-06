import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { createApp } from "../../src/api/app.js";
import { PermissionBroker } from "../../src/permissions/broker.js";
import { RulesStore } from "../../src/permissions/rules.js";
import { makeFakeQuery } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";

let app: ReturnType<typeof createApp>; let broker: PermissionBroker; let rules: RulesStore;
const TOKEN = "t".repeat(64);
const body = { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, permission_suggestions: [] };
beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hook-"));
  const store = new Store(home, path.resolve("roles")); await store.init();
  rules = new RulesStore(home); await rules.load(); broker = new PermissionBroker(rules);
  app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }), permissions: { broker, rules },
    hookToken: () => TOKEN, agentForSession: sid => (sid === "s1" ? "rev@r" : null) });
});

describe("POST /api/hooks/permission", () => {
  it("needs the token and is never a browser", async () => {
    await request(app).post("/api/hooks/permission").send(body).expect(401);
    await request(app).post("/api/hooks/permission").set("Authorization", "Bearer wrong").send(body).expect(401);
    await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).set("Sec-Fetch-Site", "same-origin").send(body).expect(403);
  });
  it("waits for the human, answered from the agent's answer route", async () => {
    const pending = request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send(body).then(r => r);
    await until(() => broker.list().length === 1);
    const id = broker.list()[0].id;
    await request(app).post("/api/agents/rev@r/answer").send({ toolUseId: id, decision: { kind: "allow" } }).expect(204);
    expect((await pending).body).toEqual({ decision: { behavior: "allow" } });
    await request(app).post("/api/agents/rev@r/answer").send({ toolUseId: id, decision: { kind: "allow" } }).expect(409);   // Review Focus 1
  });
  it("the session AgentGrid launched (sent by the hook) wins over Claude Code's own id", async () => {
    const p = request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).set("X-AgentGrid-Session", "s1").send({ ...body, session_id: "forked-id" }).then(r => r);
    await until(() => broker.list().length === 1);
    expect(broker.list()[0]).toMatchObject({ agentId: "rev@r", sessionId: "s1" });
    broker.cancel(broker.list()[0].id); await p;
  });
  it("a rule answers at once; no owning agent, a question, or a cancel all mean no decision", async () => {
    await rules.add("Bash(npm test:*)");
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send(body)).body).toEqual({ decision: { behavior: "allow" } });
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, session_id: "other" })).body).toEqual({ decision: null });
    expect((await request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, tool_name: "AskUserQuestion", tool_input: {} })).body).toEqual({ decision: null });
    const p = request(app).post("/api/hooks/permission").set("Authorization", `Bearer ${TOKEN}`).send({ ...body, tool_input: { command: "rm x" } }).then(r => r);
    await until(() => broker.list().length === 1); broker.cancel(broker.list()[0].id);
    expect((await p).body).toEqual({ decision: null });
  });
  // Review Focus 3
  it("the hook's connection closing cancels the request", async () => {
    const server = http.createServer(app).listen(0); const port = (server.address() as any).port;
    const r = http.request({ port, method: "POST", path: "/api/hooks/permission", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } });
    r.on("error", () => {}); r.end(JSON.stringify({ ...body, tool_input: { command: "rm y" } }));
    await until(() => broker.list().length === 1); r.destroy();
    await until(() => broker.list().length === 0); server.close();
  });
});

// These start real `node` processes, which can take seconds each when the whole suite runs in parallel.
describe("permission-hook.mjs", { timeout: 60_000 }, () => {
  const hook = path.resolve("presets/hooks/permission-hook.mjs");
  const runHook = (env: Record<string, string>, stdin: string) => new Promise<{ out: string; code: number }>(res => {
    const c = execFile(process.execPath, [hook], { env: { ...process.env, ...env } }, (err, out) => res({ out: String(out), code: err ? (err as any).code ?? 1 : 0 }));
    c.stdin!.end(stdin);
  });
  it("prints the decision as Claude Code's hook output", async () => {
    const server = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
      expect(req.headers.authorization).toBe("Bearer k"); expect(req.headers["x-agentgrid-session"]).toBe("s9"); expect(JSON.parse(b).tool_name).toBe("Bash");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ decision: { behavior: "deny", message: "no" } })); }); }).listen(0);
    const r = await runHook({ AGENTGRID_URL: `http://127.0.0.1:${(server.address() as any).port}`, AGENTGRID_HOOK_TOKEN: "k", AGENTGRID_SESSION_ID: "s9" }, JSON.stringify(body));
    server.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no" } } });
  });
  it("prints nothing and exits 0 when AgentGrid can't be reached, or has no decision", async () => {
    expect(await runHook({ AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" }, JSON.stringify(body))).toEqual({ out: "", code: 0 });
    expect(await runHook({}, JSON.stringify(body))).toEqual({ out: "", code: 0 });
    expect(await runHook({ AGENTGRID_URL: "http://127.0.0.1:1", AGENTGRID_HOOK_TOKEN: "k" }, "not json")).toEqual({ out: "", code: 0 });
  });
});
