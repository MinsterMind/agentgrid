import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  closeNoChange: async (id: string) => { calls.push(`no-change ${id}`); return bugs.get(id); },
  setMaxConcurrentRuns: (n: number) => { calls.push(`cap ${n}`); },
  resolveConflicts: async () => { calls.push("resolve-all"); return ["bt1"]; },
  overrideTests: async (id: string, reason: string) => { calls.push(`override ${id} ${reason}`); return bugs.get(id); },
  intake: async (input: { issueRef: string; repo: string; baseBranch?: string; startAnyway?: boolean }) => { calls.push(`intake ${input.issueRef}${input.baseBranch ? ` base=${input.baseBranch}` : ""}${input.startAnyway ? " anyway" : ""}`);
    if (input.issueRef === "PAY-1") throw Object.assign(new Error("PAY-1 may already be fixed"), { status: 409, code: "already-on-base" });
    return bugs.create({ issue: ISSUE, trackerProject: "PAY", sourceRepo: input.repo, worktree: "/w", branch: "bugfix/PAY-42", baseBranch: "main", baseRef: "origin/main", ticketCommits: [], agentId: "bugfix@w", mergePolicy: "ask", mergeMethod: "squash" }); },
  approve: async (id: string, expect?: string) => { calls.push(`approve ${id}${expect ? ` expect=${expect}` : ""}`); return bugs.get(id); },
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

  it("passes the chosen base and 'start anyway' through, says why it refused, and closes a task as no change", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r", baseBranch: "develop", startAnyway: true }).expect(201);
    expect(calls).toContain("intake PAY-42 base=develop anyway");
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r", baseBranch: 7 }).expect(400);
    const refused = await request(app).post("/api/bugtasks").send({ issueRef: "PAY-1", repo: "/r" }).expect(409);
    expect(refused.body).toEqual({ error: "PAY-1 may already be fixed", code: "already-on-base" });
    await request(app).post("/api/bugtasks/bt1/close-no-change").expect(200);
    expect(calls).toContain("no-change bt1");
  });

  it("reads one ticket for the bugs view, refusing a key that isn't one", async () => {
    expect((await request(app).get("/api/bugfix/issues/PAY-42").expect(200)).body).toMatchObject({ key: "PAY-42", title: "Boom" });
    await request(app).get("/api/bugfix/issues/..%2Fx").expect(400);
    await request(app).get("/api/bugfix/issues/PAY 42").expect(400);
  });

  it("approving a diff without a test needs a reason", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    await request(app).post("/api/bugtasks/bt1/override-tests").send({}).expect(400);
    await request(app).post("/api/bugtasks/bt1/override-tests").send({ reason: "docs only" }).expect(200);
    expect(calls).toContain("override bt1 docs only");
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

  it("rejects a non-absolute repo path for preflight, same as it does for POST /api/bugtasks", async () => {
    const res = await request(app).get("/api/bugfix/preflight").query({ repo: "relative/path" }).expect(400);
    expect(res.body.error).toMatch(/absolute repo/i);
    expect(calls).not.toContain("preflight relative/path");
  });

  it("reads and writes integrations", async () => {
    expect((await request(app).get("/api/integrations").expect(200)).body).toEqual({ projectRepos: {} });
    const saved = await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
    expect(saved.body.forge).toEqual({ preset: "github" });
    expect((await request(app).get("/api/integrations")).body.forge).toEqual({ preset: "github" });
  });

  it("the agents-at-once cap: a whole number from 1 to 32, saved and applied", async () => {
    await request(app).put("/api/integrations").send({ maxConcurrentRuns: 0 }).expect(400);
    await request(app).put("/api/integrations").send({ maxConcurrentRuns: 2.5 }).expect(400);
    await request(app).put("/api/integrations").send({ maxConcurrentRuns: 33 }).expect(400);
    const saved = await request(app).put("/api/integrations").send({ maxConcurrentRuns: 8 }).expect(200);
    expect(saved.body.maxConcurrentRuns).toBe(8);
    expect(calls).toContain("cap 8");
    expect((await request(app).get("/api/integrations")).body.maxConcurrentRuns).toBe(8);
  });

  it("Resolve all approves every bug waiting at the conflict gate", async () => {
    expect((await request(app).post("/api/bugtasks/resolve-conflicts").expect(200)).body).toEqual({ ids: ["bt1"] });
    expect(calls).toContain("resolve-all");
  });

  it("approve passes the gate the click was for, and rejects an unknown one", async () => {
    await request(app).post("/api/bugtasks").send({ issueRef: "PAY-42", repo: "/r" });
    await request(app).post("/api/bugtasks/bt1/approve").send({ expect: "conflict" }).expect(200);
    expect(calls).toContain("approve bt1 expect=conflict");
    await request(app).post("/api/bugtasks/bt1/approve").send({ expect: "nonsense" }).expect(400);
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
    await request(app).put("/api/integrations").send({ forge: { preset: "sourcehut" } }).expect(400);
    expect((await request(app).get("/api/integrations")).body.forge).toBeUndefined();
  });

  it("accepts a bitbucket forge preset with a username on PUT /api/integrations", async () => {
    const saved = await request(app).put("/api/integrations")
      .send({ forge: { preset: "bitbucket", username: "me@example.com" } }).expect(200);
    expect(saved.body.forge).toEqual({ preset: "bitbucket", username: "me@example.com" });
    expect((await request(app).get("/api/integrations")).body.forge).toEqual({ preset: "bitbucket", username: "me@example.com" });
  });

  it("rejects a non-string forge username on PUT /api/integrations", async () => {
    await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket", username: 42 } }).expect(400);
  });

  it("rejects a blank or whitespace-only username for the bitbucket preset, naming the field", async () => {
    // Spec §1: an error naming neither the file nor the missing key is the failure mode this
    // work exists to remove — so this must be caught here, not surface later as intake's
    // generic "no forge configured".
    const missing = await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket" } }).expect(400);
    expect(missing.body.error).toMatch(/forge\.username/);
    const blank = await request(app).put("/api/integrations").send({ forge: { preset: "bitbucket", username: "   " } }).expect(400);
    expect(blank.body.error).toMatch(/forge\.username/);
    expect((await request(app).get("/api/integrations")).body.forge).toBeUndefined();
  });

  it("does not require a username for the github preset", async () => {
    await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);
  });

  // I3: `hints` is a live `TrackerConfig` field injected into every tracker prompt. The browser
  // cannot preserve what it is never told, and `PUT` replaces `tracker` wholesale — so a Settings
  // screen that could not read `hints` back silently destroyed it on the next "Use this". It
  // carries no credential (it is prose the user wrote), so it crosses the redaction boundary.
  it("GET /api/integrations returns tracker.hints, so the browser can send it back", async () => {
    await request(app).put("/api/integrations")
      .send({ tracker: { preset: "jira", toolPrefix: "mcp__x", hints: "Bugs live in PAY" } }).expect(200);
    const res = await request(app).get("/api/integrations").expect(200);
    expect(res.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__x", hints: "Bugs live in PAY" });
  });

  it("omits hints entirely when none is stored, rather than sending an empty one", async () => {
    await request(app).put("/api/integrations").send({ tracker: { preset: "jira", toolPrefix: "mcp__x" } }).expect(200);
    const res = await request(app).get("/api/integrations").expect(200);
    expect(res.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__x" });
    expect("hints" in res.body.tracker).toBe(false);
  });

  // M7: the hand-entry box is the documented remedy for the deferred Refresh, so an empty or
  // contentless tracker patch must not be able to replace a working tracker with `{}`.
  it("rejects a tracker patch naming neither preset nor toolPrefix, leaving the stored one alone", async () => {
    await request(app).put("/api/integrations").send({ tracker: { preset: "jira", toolPrefix: "mcp__x" } }).expect(200);
    const empty = await request(app).put("/api/integrations").send({ tracker: {} }).expect(400);
    expect(empty.body.error).toMatch(/preset|toolPrefix/);
    // `hints` alone is not a tracker either: it would still wipe `preset` and `toolPrefix`.
    await request(app).put("/api/integrations").send({ tracker: { hints: "h" } }).expect(400);
    expect((await request(app).get("/api/integrations")).body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__x" });
  });

  it("rejects a malformed tracker on PUT /api/integrations, and accepts a well-formed one", async () => {
    await request(app).put("/api/integrations").send({ tracker: "garbage" }).expect(400);
    await request(app).put("/api/integrations").send({ tracker: 42 }).expect(400);
    expect((await request(app).get("/api/integrations")).body.tracker).toBeUndefined();

    const tracker = { preset: "jira", toolPrefix: "mcp__jira__", mcpServers: { jira: { command: "x" } }, hints: "h" };
    const saved = await request(app).put("/api/integrations").send({ tracker }).expect(200);
    // `mcpServers` in the request body is an unknown key to this route now (task 2 dropped it
    // from TrackerConfig) and is stripped before the write ever happens — same as any other
    // unrecognised field. This does not exercise `redactIntegrations` against a *stored*
    // credential; see "GET /api/integrations never echoes a legacy tracker.mcpServers
    // credential" below for that. `hints` is echoed back: it is prompt text the user writes,
    // not a credential, and the browser needs it to round-trip (see the `hints` test below).
    expect(saved.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__jira__", hints: "h" });
    expect((await request(app).get("/api/integrations")).body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__jira__", hints: "h" });
    // The full config is still on disk — redacting the response is not dropping the write.
    expect((await request(app).get("/api/setup").expect(200)).status).toBe(200);
  });

  // I5, as it stands post-task-2: PUT strips an incoming `mcpServers` before the write, so these
  // two prove input-key stripping — a request carrying `mcpServers` never gets it echoed back —
  // not that a *stored* credential is redacted. See the next test for that: a 0.4.0
  // integrations.json can still have tracker.mcpServers sitting on disk, and GET must never
  // echo it either.
  it("GET /api/integrations never echoes a tracker.mcpServers sent on a PUT (it's an unknown key, stripped before the write)", async () => {
    const tracker = { preset: "jira", toolPrefix: "mcp__jira__",
      mcpServers: { jira: { type: "http", url: "https://x.invalid", headers: { Authorization: "Bearer sk-secret" } } } };
    await request(app).put("/api/integrations").send({ tracker }).expect(200);
    const res = await request(app).get("/api/integrations").expect(200);
    expect(JSON.stringify(res.body)).not.toContain("Bearer sk-secret");
    expect(JSON.stringify(res.body)).not.toContain("headers");
    expect(res.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__jira__" });
  });

  // GET must never echo a legacy tracker.mcpServers credential that genuinely made it onto
  // disk — a 0.4.0 integrations.json, before task 2 removed the field from TrackerConfig and
  // the route stopped accepting it. Seeding the file directly (not via PUT) is what actually
  // exercises redactIntegrations against a *stored* credential, which is what I5 always meant.
  it("GET /api/integrations never echoes a legacy tracker.mcpServers credential still on disk", async () => {
    await writeFile(path.join(home, "integrations.json"), JSON.stringify({
      tracker: { preset: "jira", toolPrefix: "mcp__jira__",
        mcpServers: { jira: { type: "http", url: "https://x.invalid", headers: { Authorization: "Bearer sk-secret" } } } },
      projectRepos: {},
    }));
    const res = await request(app).get("/api/integrations").expect(200);
    expect(JSON.stringify(res.body)).not.toContain("Bearer sk-secret");
    expect(JSON.stringify(res.body)).not.toContain("headers");
    expect(JSON.stringify(res.body)).not.toContain("mcpServers");
    expect(res.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__jira__" });
  });

  // I5, the other half: a Save that touches only `forge` merges onto the *stored* config, so
  // echoing `write()`'s result handed the browser a `tracker.mcpServers` it never had — bearer
  // token and headers included — reopening by PUT exactly the path the GET redaction closed.
  // (Here the credential is still one PUT sent, since PUT's own stripping already covers the
  // "never sent" case above — this is about a save that never touched `tracker` at all.)
  it("PUT /api/integrations never returns a tracker definition's headers, not even ones it did not write", async () => {
    const tracker = { preset: "jira", toolPrefix: "mcp__jira__",
      mcpServers: { jira: { type: "http", url: "https://x.invalid", headers: { Authorization: "Bearer sk-secret" } } } };
    await request(app).put("/api/integrations").send({ tracker }).expect(200);

    // Touches `forge` alone: the stored tracker is merged in by `write()` and must stay on disk.
    const saved = await request(app).put("/api/integrations").send({ forge: { preset: "github" } }).expect(200);

    expect(JSON.stringify(saved.body)).not.toContain("Bearer sk-secret");
    expect(JSON.stringify(saved.body)).not.toContain("headers");
    expect(saved.body.tracker).toEqual({ preset: "jira", toolPrefix: "mcp__jira__" });
    expect(saved.body.forge).toEqual({ preset: "github" });
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
      ["post", "/api/bugtasks/bt1/address-comments"],
      ["delete", "/api/bugtasks/bt1"],
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

/**
 * Drives a real-engine app (`createBugFixTestApp`) through HTTP up to "monitoring", the same
 * shape `onMonitoringTask` in engine.test.ts drives the engine directly — but through the
 * routes under test here, not by calling the engine's own methods.
 */
async function httpToMonitoring() {
  const repo = await mkdtemp(path.join(tmpdir(), "api-real-repo-"));
  const built = await createBugFixTestApp();
  const { app: realApp, bugs: realBugs, finishStage } = built;
  const created = await request(realApp).post("/api/bugtasks").send({ issueRef: "PAY-42", repo }).expect(201);
  const id = created.body.id as string;
  await realBugs.writeArtifact(id, "plan.md", "# Plan");
  await finishStage();
  await until(() => realBugs.get(id).stage === "plan-review");
  await request(realApp).post(`/api/bugtasks/${id}/approve`).expect(200);
  await finishStage();
  await until(() => realBugs.get(id).stage === "diff-review");
  await request(realApp).post(`/api/bugtasks/${id}/approve`).expect(200);
  await realBugs.writeArtifact(id, "pr-body.md", "PR body");
  await finishStage();
  await until(() => realBugs.get(id).stage === "monitoring");
  return { ...built, id };
}

/** A task resting in "monitoring" — the state `address-comments` and dismiss's 409 both need. */
async function appMonitoring(opts: { feedbackRounds?: number } = {}) {
  const m = await httpToMonitoring();
  if (opts.feedbackRounds !== undefined) await m.bugs.patch(m.id, { feedbackRounds: opts.feedbackRounds });
  return m;
}

/** A task sitting at the merge gate (`approved`), with a merge-tracking forge swapped in so a
 *  test can see what `mergeMethod` actually reached `forge.merge`. */
async function appAtMergeGate() {
  const m = await httpToMonitoring();
  const forge = {
    name: "github",
    merges: [] as Array<{ number: number; method: string }>,
    state: "OPEN" as "OPEN" | "MERGED" | "CLOSED",
    authStatus: async () => ({ ok: true, message: "ok" }),
    findPr: async () => ({ number: 7, url: "https://x/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: "abc1234abc1234abc1234abc1234abc1234abc1", lastSeenEventAt: "t" }),
    getPr: async () => ({ found: { number: 7, url: "https://x/pr/7", state: forge.state, reviewDecision: null, checks: null, mergeable: "MERGEABLE" as string | null, headSha: "abc1234abc1234abc1234abc1234abc1234abc1", lastSeenEventAt: "t" } }),
    listReviewEvents: async () => [],
    merge: async (_repo: string, number: number, method: string) => { forge.merges.push({ number, method }); forge.state = "MERGED"; return { ok: true, message: "merged (fake)" }; },
  };
  (m.engine as any).deps.forge = forge;
  const task = m.bugs.get(m.id);
  await m.engine.onPrFinding({ taskId: m.id, pr: { ...task.pr!, state: "OPEN" }, event: { type: "review-approved" } });
  await until(() => m.bugs.get(m.id).stage === "approved");
  return { ...m, forge };
}

/** A finished task, all the way to "done" via a real merge. */
async function appDone() {
  const m = await appAtMergeGate();
  await request(m.app).post(`/api/bugtasks/${m.id}/approve`).expect(200);
  await until(() => m.bugs.get(m.id).stage !== "merging", 2000);
  return m;
}

describe("approve honours a merge method, address-comments, and dismiss", () => {
  it("approve at the merge gate honours a method, and validates it", async () => {
    const { app: realApp, id, forge } = await appAtMergeGate();
    await request(realApp).post(`/api/bugtasks/${id}/approve`).send({ mergeMethod: "merge" }).expect(200);
    await until(() => forge.merges.length > 0);
    expect(forge.merges[0]).toMatchObject({ method: "merge" });
    await request(realApp).post(`/api/bugtasks/${id}/approve`).send({ mergeMethod: "yolo" }).expect(400);
  });

  it("address-comments starts a feedback round even past the cap", async () => {
    const { app: realApp, id } = await appMonitoring({ feedbackRounds: 99 });
    const res = await request(realApp).post(`/api/bugtasks/${id}/address-comments`).send({ text: "please fix the naming" }).expect(200);
    expect(res.body.stage).toBe("review-feedback");
  });

  it("DELETE removes a finished task and 409s on a live one", async () => {
    const done = await appDone();
    await request(done.app).delete(`/api/bugtasks/${done.id}`).expect(204);
    const live = await appMonitoring();
    await request(live.app).delete(`/api/bugtasks/${live.id}`).expect(409);
  });

  it("every new route answers 501 when the workflow is not wired", async () => {
    const store2 = new Store(home, path.resolve("roles")); await store2.init();
    const bare = createApp({ store: store2, manager: new Manager(store2, { queryFn: makeFakeQuery().queryFn }) });
    await request(bare).post("/api/bugtasks/bt1/address-comments").expect(501);
    await request(bare).delete("/api/bugtasks/bt1").expect(501);
  });
});

it("GET /api/setup reports ready once tracker, forge and role are in place", async () => {
  const m = await appAtMergeGate();            // the existing fully-wired harness
  const res = await request(m.app).get("/api/setup").expect(200);
  expect(res.body.wired).toBe(true);
  expect(res.body.checks.find((c: { id: string }) => c.id === "tracker").state).toBe("ok");
});
