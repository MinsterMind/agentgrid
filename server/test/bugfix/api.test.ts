import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { createApp } from "../../src/api/app.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";
import { createBugFixTestApp } from "./realEngineApp.js";
import type { BugTask, TrackerIssue } from "../../src/bugfix/types.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };
let app: ReturnType<typeof createApp>; let bugs: BugTaskStore; let calls: string[]; let home: string;

/** A stand-in engine: records what the routes asked for, mutates the store just enough. */
const fakeEngine = (bugs: BugTaskStore, calls: string[]) => ({
  preflight: async (repo: string) => { calls.push(`preflight ${repo}`); return { ok: true, problems: [] }; },
  intake: async (input: { issueRef: string; repo: string }) => { calls.push(`intake ${input.issueRef}`);
    return bugs.create({ issue: ISSUE, trackerProject: "PAY", sourceRepo: input.repo, worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", agentId: "bugfix@w", mergePolicy: "ask", mergeMethod: "squash" }); },
  approve: async (id: string) => { calls.push(`approve ${id}`); return bugs.get(id); },
  requestChanges: async (id: string, text: string) => { calls.push(`changes ${id} ${text}`); return bugs.get(id); },
  cancel: async (id: string) => { calls.push(`cancel ${id}`); return bugs.get(id); },
  retry: async (id: string) => { calls.push(`retry ${id}`); return bugs.get(id); },
  diffFor: async (id: string) => { calls.push(`diff ${id}`); return { patch: "p", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 }; },
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "api-"));
  const store = new Store(home, path.resolve("roles")); await store.init();
  bugs = new BugTaskStore(home); await bugs.init();
  calls = [];
  app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }),
    bugs: { engine: fakeEngine(bugs, calls) as never, store: bugs, integrations: new IntegrationsStore(home),
            tracker: { listMyIssues: async () => [{ key: "PAY-42", title: "Boom", url: "u", status: "Open", priority: "High" }], fetchIssue: async () => ISSUE, comment: async () => {} } } });
});

describe("bug task routes", () => {
  it("creates a task and lists it, and exposes it in /api/state", async () => {
    await request(app).post("/api/bugtasks").send({ repo: "/r" }).expect(400);              // issueRef required
    const res = await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" }).expect(201);
    expect(res.body).toMatchObject({ id: "bt1", stage: "intake" });
    expect(calls).toContain("intake PAY-42");
    expect((await request(app).get("/api/bugtasks").expect(200)).body.map((t: BugTask) => t.id)).toEqual(["bt1"]);
    expect((await request(app).get("/api/state").expect(200)).body.bugTasks).toHaveLength(1);
    await request(app).get("/api/bugtasks/nope").expect(404);
  });

  it("serves the plan markdown and the computed diff", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    expect((await request(app).get("/api/bugtasks/bt1/plan").expect(200)).body).toEqual({ markdown: "" });
    await bugs.writeArtifact("bt1", "plan.md", "# Plan\nfix");
    expect((await request(app).get("/api/bugtasks/bt1/plan").expect(200)).body.markdown).toContain("# Plan");
    const d = await request(app).get("/api/bugtasks/bt1/diff").expect(200);
    expect(d.body).toMatchObject({ additions: 1, files: [{ path: "a" }] });
    expect(calls).toContain("diff bt1");
  });

  it("routes the gate actions to the engine", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    await request(app).post("/api/bugtasks/bt1/approve").expect(200);
    await request(app).post("/api/bugtasks/bt1/request-changes").send({ text: "" }).expect(400);
    await request(app).post("/api/bugtasks/bt1/request-changes").send({ text: "redo it" }).expect(200);
    await request(app).post("/api/bugtasks/bt1/cancel").expect(200);
    await request(app).post("/api/bugtasks/bt1/retry").expect(200);
    expect(calls).toEqual(expect.arrayContaining(["approve bt1", "changes bt1 redo it", "cancel bt1", "retry bt1"]));
  });

  it("lists my issues and runs preflight", async () => {
    expect((await request(app).get("/api/bugfix/issues").expect(200)).body[0].key).toBe("PAY-42");
    expect((await request(app).get("/api/bugfix/preflight").query({ repo: "/r" }).expect(200)).body).toEqual({ ok: true, problems: [] });
    await request(app).get("/api/bugfix/preflight").expect(400);
  });

  it("reads and writes integrations", async () => {
    expect((await request(app).get("/api/integrations").expect(200)).body).toEqual({ projectRepos: {} });
    const saved = await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect(saved.body.forge).toEqual({ preset: "github" });
    expect((await request(app).get("/api/integrations")).body.forge).toEqual({ preset: "github" });
  });

  it("returns a single bug task by id", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    const res = await request(app).get("/api/bugtasks/bt1").expect(200);
    expect(res.body).toMatchObject({ id: "bt1", stage: "intake" });
  });

  it("404s a malformed id on a route other than the plain GET", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    await request(app).post("/api/bugtasks/not-a-real-id/approve").expect(404);
    await request(app).get("/api/bugtasks/../etc/plan").expect(404);
  });

  it("rejects an out-of-enum mergePolicy or mergeMethod", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r", mergePolicy: "yolo" }).expect(400);
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r", mergeMethod: "smash" }).expect(400);
    expect(calls).not.toContain("intake PAY-42"); // rejected before the engine is ever called
  });

  it("rejects an out-of-enum forge preset on PUT /api/integrations", async () => {
    await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket" } }).expect(400);
    expect((await request(app).get("/api/integrations")).body.forge).toBeUndefined();
  });

  it("returns 501 for every bug route when the feature is not wired", async () => {
    const store = new Store(home, path.resolve("roles")); await store.init();
    const bare = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }) });
    const routes: Array<[string, string]> = [
      ["get", "/api/bugtasks"],
      ["get", "/api/bugtasks/bt1"],
      ["get", "/api/bugtasks/bt1/plan"],
      ["get", "/api/bugtasks/bt1/diff"],
      ["post", "/api/bugtasks"],
      ["post", "/api/bugtasks/bt1/approve"],
      ["post", "/api/bugtasks/bt1/cancel"],
      ["post", "/api/bugtasks/bt1/retry"],
      ["post", "/api/bugtasks/bt1/request-changes"],
      ["get", "/api/bugfix/issues"],
      ["get", "/api/bugfix/preflight?repo=/r"],
      ["get", "/api/integrations"],
      ["put", "/api/integrations"],
    ];
    for (const [method, url] of routes) {
      const r = method === "get"
        ? await request(bare).get(url)
        : await (request(bare) as any)[method](url).send({ text: "x", issueRef: "x", repo: "/r" });
      expect(r.status, `${method.toUpperCase()} ${url}`).toBe(501);
    }
  });
});

describe("gate races surface as 409, never 500", () => {
  it("two concurrent approves over the real engine yield exactly one 200 and one 409", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "api-real-repo-"));
    const { app: realApp, bugs: realBugs, finishStage } = await createBugFixTestApp();
    const created = await request(realApp).post("/api/bugtasks").send({ issueRef: "PAY-42", repo }).expect(201);
    const id = created.body.id as string;
    await realBugs.writeArtifact(id, "plan.md", "# Plan");
    await finishStage();
    await until(() => realBugs.get(id).stage === "plan-review");

    const [r1, r2] = await Promise.all([
      request(realApp).post(`/api/bugtasks/${id}/approve`),
      request(realApp).post(`/api/bugtasks/${id}/approve`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(realBugs.get(id).stage).toBe("implementing");
  });

  it("a gate call against a task in the wrong stage is a 409, not a 500", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "api-real-repo-"));
    const { app: realApp } = await createBugFixTestApp();
    const created = await request(realApp).post("/api/bugtasks").send({ issueRef: "PAY-42", repo }).expect(201);
    const id = created.body.id as string;
    // Task is still "analyzing" (an agent stage), which does not accept "approve".
    await request(realApp).post(`/api/bugtasks/${id}/approve`).expect(409);
  });
});
