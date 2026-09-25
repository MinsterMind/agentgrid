import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { BugFixEngine } from "../../src/bugfix/engine.js";
import { GitOps } from "../../src/bugfix/git.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery, success } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { BugTask, TrackerIssue } from "../../src/bugfix/types.js";
import type { Assignment } from "../../src/types.js";
import type { QueryFn } from "../../src/runner/runner.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };

/** Fake git: records calls, pretends a worktree and commits exist. */
function fakeGit(state: { commits: number; head?: string }) {
  const calls: string[] = [];
  const g = new GitOps(async () => "");
  g.defaultBranch = async () => "main";
  g.hasRemote = async () => "git@github.com:acme/pay.git";
  g.createWorktree = async (repo, branch) => { calls.push(`create ${branch}`); const d = path.join(repo, ".worktrees", branch.replace("/", "-")); await mkdir(d, { recursive: true }); return d; };
  g.removeWorktree = async () => { calls.push("remove"); };
  g.currentBranch = async () => "bugfix/PAY-42";
  g.revParse = async () => state.head ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  g.commitsAhead = async () => state.commits;
  g.diff = async () => ({ patch: "diff --git a/a b/a\n+x\n", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 });
  return { git: g, calls };
}

const forge = {
  name: "github",
  authStatus: async () => ({ ok: true, message: "ok" }),
  createPrCommand: () => "gh pr create --base 'main' --head 'bugfix/PAY-42' --title 't' --body-file '/b'",
  findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", lastSeenEventAt: "t" }),
};

let home: string; let repo: string; let store: Store; let bugs: BugTaskStore; let fake: ReturnType<typeof makeFakeQuery>;
let engine: BugFixEngine; let comments: Array<[string, string]>; let gitState: { commits: number; head?: string };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "eng-home-"));
  repo = await mkdtemp(path.join(tmpdir(), "eng-repo-"));
  store = new Store(home, path.resolve("roles")); await store.init();
  await writeFile(path.join(home, "roles", "bugfix.md"), `---\nname: bugfix\navatar: 🐞\nmodel: claude-opus-5\n---\nYou fix bugs.`);
  await store.reloadRoles();
  bugs = new BugTaskStore(home); await bugs.init();
  fake = makeFakeQuery();
  gitState = { commits: 0 };
  comments = [];
  engine = new BugFixEngine({
    store, bugs, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
    git: fakeGit(gitState).git, integrations: new IntegrationsStore(home),
    tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async (k, t) => { comments.push([k, t]); } },
    forge, presetsDir: path.resolve("presets"),
  });
  engine.attach();
});

const finishStage = async () => { fake.emit(success("done")); fake.end(); };

describe("intake", () => {
  it("creates the agent, worktree and task, remembers the repo, and starts analyzing", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    expect(t.issue.key).toBe("PAY-42");
    expect(t.branch).toBe("bugfix/PAY-42");
    expect(t.stage).toBe("analyzing");
    const agent = store.getAgent(t.agentId);
    expect(agent).toMatchObject({ role: "bugfix", displayName: "PAY-42", repo: t.worktree, state: "working" });
    expect(fake.calls[0].prompt).toContain("PAY-42");
    expect(await new IntegrationsStore(home).repoFor("PAY")).toBe(repo);
  });

  it("refuses when the repo has no remote", async () => {
    const g = fakeGit(gitState).git; g.hasRemote = async () => null;
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    await expect(e2.intake({ issueRef: "PAY-42", repo })).rejects.toThrow(/remote/i);
  });
});

describe("stage progression", () => {
  it("analyzing → plan gate once plan.md exists", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan\nroot cause");
    await finishStage();
    await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).gate).toMatchObject({ kind: "plan" });
    expect(store.getAgent(t.agentId).state).toBe("free");  // acked, ready for the next stage
  });

  it("fails the stage when the agent did not write plan.md", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await finishStage();
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/plan\.md/);
  });

  it("approving the plan runs implementing with the plan in the prompt", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    expect(bugs.get(t.id).stage).toBe("implementing");
    expect(fake.calls.at(-1)!.prompt).toContain("plan.md");
  });

  it("request-changes loops back with the note in the prompt", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.requestChanges(t.id, "cover the retry path");
    expect(bugs.get(t.id).stage).toBe("analyzing");
    expect(fake.calls.at(-1)!.prompt).toContain("cover the retry path");
  });

  it("implementing needs a commit; with one it opens the diff gate and stores the diff", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");   // 0 commits
    expect(bugs.get(t.id).error).toMatch(/no commits/i);

    gitState.commits = 1;
    await engine.retry(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    expect(await bugs.readArtifact(t.id, "diff.patch")).toContain("diff --git");
    expect(JSON.parse((await bugs.readArtifact(t.id, "diffstat.json"))!)).toMatchObject({ additions: 1, files: [{ path: "a" }] });
    expect((await engine.diffFor(t.id)).files[0].path).toBe("a");
  });

  it("approving the diff opens the PR, records it, comments on the ticket and rests in monitoring", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    await engine.approve(t.id);
    expect(fake.calls.at(-1)!.prompt).toContain("gh pr create");
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
    expect(bugs.get(t.id).pr).toMatchObject({ number: 7, url: "https://gh/pr/7" });
    expect(comments).toEqual([["PAY-42", expect.stringContaining("https://gh/pr/7")]]);
  });

  it("opening-pr fails when the forge cannot find the PR", async () => {
    // Fully independent engine (own store/bugs/manager/fake) so this test exercises the
    // findPr()-returns-null failure path itself, not the ownership scoping that keeps a
    // second, differently-configured engine on the *same* store from racing this one.
    const home2 = await mkdtemp(path.join(tmpdir(), "eng-home2-"));
    const store2 = new Store(home2, path.resolve("roles")); await store2.init();
    await writeFile(path.join(home2, "roles", "bugfix.md"), `---\nname: bugfix\navatar: 🐞\nmodel: claude-opus-5\n---\nYou fix bugs.`);
    await store2.reloadRoles();
    const bugs2 = new BugTaskStore(home2); await bugs2.init();
    const fake2 = makeFakeQuery();
    const gitState2 = { commits: 0 };
    const e2 = new BugFixEngine({
      store: store2, bugs: bugs2,
      manager: new Manager(store2, { queryFn: fake2.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
      git: fakeGit(gitState2).git, integrations: new IntegrationsStore(home2),
      tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} },
      forge: { ...forge, findPr: async () => null }, presetsDir: path.resolve("presets"),
    });
    e2.attach();
    const finishStage2 = async () => { fake2.emit(success("done")); fake2.end(); };

    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs2.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "plan-review");
    await e2.approve(t.id); gitState2.commits = 1;
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "diff-review");
    await e2.approve(t.id);
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "failed");
    expect(bugs2.get(t.id).error).toMatch(/no pull request/i);
  });
});

describe("cancel and guards", () => {
  it("cancel stops the task and leaves the worktree alone", async () => {
    const { git, calls } = fakeGit(gitState);
    const e2 = new BugFixEngine({ ...(engine as any).deps, git });
    e2.attach();
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await e2.cancel(t.id);
    expect(bugs.get(t.id).stage).toBe("cancelled");
    expect(store.getAgent(t.agentId).state).not.toBe("working");
    expect(calls).not.toContain("remove");
  });
  it("a failed agent assignment fails the task with the agent's error", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    fake.emit({ type: "result", subtype: "error_max_turns", num_turns: 40, total_cost_usd: 1, duration_ms: 1, is_error: true } as never);
    fake.end();
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/error_max_turns/);
  });
  it("accumulates cost across stages", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    fake.emit(success("done", 0.5)); fake.end();
    await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).costUsd).toBeCloseTo(0.5);

    await engine.approve(t.id);
    gitState.commits = 1;
    fake.emit(success("done", 0.25)); fake.end();
    await until(() => bugs.get(t.id).stage === "diff-review");
    expect(bugs.get(t.id).costUsd).toBeCloseTo(0.75);
  });
});

describe("concurrent gate calls are serialised per task", () => {
  it("double-clicking approve at a gate dispatches exactly one stage; the loser rejects and the task is never marked failed", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");

    const results = await Promise.allSettled([engine.approve(t.id), engine.approve(t.id)]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason?.status).toBe(409); // the loser is a Conflict, not an unhandled 500
    expect(bugs.get(t.id).stage).toBe("implementing");
    expect(bugs.get(t.id).stage).not.toBe("failed");
  });

  it("approve racing requestChanges at a gate: exactly one wins, the task is never marked failed", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");

    const results = await Promise.allSettled([engine.approve(t.id), engine.requestChanges(t.id, "cover the retry path")]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason?.status).toBe(409);
    expect(bugs.get(t.id).stage).not.toBe("failed");
    expect(["implementing", "analyzing"]).toContain(bugs.get(t.id).stage);
  });
});

describe("opening-pr requires an OPEN pull request", () => {
  async function toDiffReview(e: BugFixEngine): Promise<BugTask> {
    const t = await e.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await e.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    return t;
  }

  it("fails the stage instead of advancing when findPr returns a MERGED pull request", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "MERGED" as const, reviewDecision: null, checks: null, mergeable: null, lastSeenEventAt: "t" }) } });
    e2.attach();
    const t = await toDiffReview(e2);
    await e2.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/merged/i);
    expect(bugs.get(t.id).error).toMatch(/#7/);
  });

  it("fails the stage instead of advancing when findPr returns a CLOSED pull request", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "CLOSED" as const, reviewDecision: null, checks: null, mergeable: null, lastSeenEventAt: "t" }) } });
    e2.attach();
    const t = await toDiffReview(e2);
    await e2.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/closed/i);
    expect(bugs.get(t.id).error).toMatch(/#7/);
  });

  it("an OPEN pull request still advances to monitoring", async () => {
    const t = await toDiffReview(engine);
    await engine.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
    expect(bugs.get(t.id).pr).toMatchObject({ state: "OPEN" });
  });
});

describe("dispatch ownership is tracked in memory, per task", () => {
  it("ignores an assignment event whose id does not match what this task actually dispatched", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    const bogus: Assignment = {
      id: "a-bogus-not-dispatched", agentId: t.agentId, prompt: "x", createdAt: new Date().toISOString(),
      startedAt: null, endedAt: null, sessionId: null, state: "done", activity: "", pending: null,
      outcome: "done", error: null, turns: 1, costUsd: 0,
    };
    (store as unknown as { emit: (e: string, v: unknown) => void }).emit("event", { type: "assignment", assignment: bogus });
    // Long enough to clear the internal agent-state poll's own timeout, so a naive
    // implementation that merely filters by agentId (and would eventually try to verify
    // and fail the stage once that poll gives up) can't pass this by accident.
    await new Promise(r => setTimeout(r, 1200));
    expect(bugs.get(t.id).stage).toBe("analyzing"); // untouched — the real, dispatched assignment hasn't finished
    expect(bugs.get(t.id).costUsd).toBe(0);
  });

  it("recovers a task stuck mid-stage after a restart: it's marked failed, and retry() works again", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    // Simulate a restart: a fresh engine instance over the same durable stores, with no
    // in-memory state at all, sees this task still sitting in an agent stage. Task 14's
    // documented order applies: Manager.recoverOnStart() first (frees the stuck agent),
    // then the engine's own recoverOnStart().
    const deps = (engine as any).deps;
    await deps.manager.recoverOnStart();
    const fresh = new BugFixEngine(deps);
    await fresh.recoverOnStart();
    expect(bugs.get(t.id).stage).toBe("failed");
    expect(bugs.get(t.id).error).toMatch(/restart/i);

    fresh.attach();
    gitState.commits = 0;
    const retried = await fresh.retry(t.id);
    expect(retried.stage).toBe("analyzing");
  });
});

describe("intake refuses a repo with no pollable forge", () => {
  it("rejects before creating any agent or worktree", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: null });
    await expect(e2.intake({ issueRef: "PAY-42", repo })).rejects.toThrow(/forge/i);
  });
});

describe("implementing verifies the worktree is actually on the task branch", () => {
  it("fails the stage naming both branches when the worktree has moved off it", async () => {
    const g = fakeGit(gitState).git;
    g.currentBranch = async () => "some-other-branch";
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    e2.attach();
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await e2.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/some-other-branch/);
    expect(bugs.get(t.id).error).toMatch(/bugfix\/PAY-42/);
  });
});

describe("attach() is idempotent", () => {
  it("calling attach() twice does not double-process a finished stage", async () => {
    engine.attach(); // second call — should be a no-op
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    fake.emit(success("done", 0.5)); fake.end();
    await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).costUsd).toBeCloseTo(0.5); // not 1.0
  });
});

describe("advance() failure handling preserves the original error", () => {
  it("surfaces the original failure reason, not a confusing terminal-stage one, when the task goes terminal mid-attempt", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");

    const deps = (engine as any).deps;
    const originalCommitsAhead = deps.git.commitsAhead;
    // Simulate the task being cancelled by someone else in the moment between the
    // opening-pr guard's commit check and advance()'s own failure handler running.
    deps.git.commitsAhead = async (...args: unknown[]) => {
      await bugs.apply(t.id, { stage: "cancelled", run: null, gate: null, note: "", error: null });
      return 0;
    };
    try {
      await expect(engine.approve(t.id)).rejects.toThrow(/no commits to open a pull request/i);
      expect(bugs.get(t.id).stage).toBe("cancelled"); // not stomped back to "failed"
    } finally {
      deps.git.commitsAhead = originalCommitsAhead;
    }
  });
});

describe("requestChanges and diffFor reject asynchronously rather than throwing synchronously", () => {
  it("requestChanges", async () => {
    let threwSync = false; let p: Promise<unknown>;
    try { p = engine.requestChanges("bt-does-not-exist", "  "); } catch { threwSync = true; p = Promise.resolve(); }
    expect(threwSync).toBe(false);
    await expect(p!).rejects.toThrow(/say what should change/);
  });

  it("diffFor", async () => {
    let threwSync = false; let p: Promise<unknown>;
    try { p = engine.diffFor("bt-does-not-exist"); } catch { threwSync = true; p = Promise.resolve(); }
    expect(threwSync).toBe(false);
    await expect(p!).rejects.toThrow(/bug task/i);
  });
});

describe("adversarial: a duplicate or late stage-done event", () => {
  it("does not advance a task that is already resting at a gate", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage();
    await until(() => bugs.get(t.id).stage === "plan-review");

    const finished = store.listAssignments(50).find(a => a.agentId === t.agentId && a.state === "done")!;
    expect(finished).toBeTruthy();
    (store as unknown as { emit: (e: string, v: unknown) => void }).emit("event", { type: "assignment", assignment: finished });
    await new Promise(r => setTimeout(r, 50));
    expect(bugs.get(t.id).stage).toBe("plan-review"); // still at the gate, not re-advanced
  });
});

describe("a synchronously-throwing queryFn does not strand the task", () => {
  it("leaves the task failed with the error surfaced, and retry() then succeeds", async () => {
    const throwingQueryFn: QueryFn = () => { throw new Error("Native CLI binary for darwin-arm64 not found"); };
    const failingManager = new Manager(store, { queryFn: throwingQueryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) });
    const e2 = new BugFixEngine({ ...(engine as any).deps, manager: failingManager });
    e2.attach();

    // Runner.assign() catches a synchronously-throwing queryFn internally and calls
    // finish({state:"failed"}) *before* assign() itself returns — so the "assignment"
    // event fires while the engine is still mid-dispatch, before it can record
    // ownership of the (by-then-already-terminal) assignment. intake() must still end
    // up with the task failed, not stuck in "analyzing" forever.
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/could not start claude code/i);

    // The durable failure is not a dead end: retry() (via the normal, working manager)
    // dispatches a fresh attempt on the same task.
    const retried = await engine.retry(t.id);
    expect(retried.stage).toBe("analyzing");
  });
});

describe("an assignment that fails on the first stream iteration does not strand the task", () => {
  // Unlike a synchronously-throwing queryFn, manager.assign() resolves normally here
  // (state "working") — the failure only surfaces later, asynchronously, once Runner's
  // background consume() loop actually iterates the stream. That's exactly the window
  // between assign() resolving and the engine finishing recording ownership of it.
  it("an async generator that throws on its first next() leaves the task failed, and retry() works", async () => {
    const throwingStreamQueryFn: QueryFn = () => (async function* () {
      throw new Error("spawn ENOENT");
    })();
    const failingManager = new Manager(store, { queryFn: throwingStreamQueryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) });
    const e2 = new BugFixEngine({ ...(engine as any).deps, manager: failingManager });
    e2.attach();

    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/spawn enoent/i);

    const retried = await engine.retry(t.id);
    expect(retried.stage).toBe("analyzing");
  });

  // runner.ts produces this one on its own whenever a stream ends without ever
  // yielding a "result" message — e.g. an immediately-aborted or empty stream.
  it("a stream that ends without a result leaves the task failed, and retry() works", async () => {
    const emptyStreamQueryFn: QueryFn = () => (async function* () {
      /* yields nothing, returns immediately */
    })();
    const failingManager = new Manager(store, { queryFn: emptyStreamQueryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) });
    const e2 = new BugFixEngine({ ...(engine as any).deps, manager: failingManager });
    e2.attach();

    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/stream ended without result/i);

    const retried = await engine.retry(t.id);
    expect(retried.stage).toBe("analyzing");
  });
});

describe("requestChanges never leaks its note into an unrelated stage", () => {
  it("does not store the note when the task isn't at a gate", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    // t.stage is "analyzing" — not a gate.
    await expect(engine.requestChanges(t.id, "cover the retry path")).rejects.toThrow(/cannot request changes while analyzing/i);
    await expect(engine.requestChanges(t.id, "cover the retry path")).rejects.toMatchObject({ status: 409 });

    // The next legitimate stage prompt (once the plan gate is reached and approved)
    // must not carry that rejected note.
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    expect(fake.calls.at(-1)!.prompt).not.toContain("cover the retry path");
    expect(fake.calls.at(-1)!.prompt).not.toContain("Additional instructions from the reviewer");
  });

  it("does not leak the loser's note when requestChanges loses a race against approve", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");

    const results = await Promise.allSettled([engine.approve(t.id), engine.requestChanges(t.id, "this note must not leak")]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason?.status).toBe(409);
    expect(bugs.get(t.id).stage).toBe("implementing"); // approve won
    expect(fake.calls.at(-1)!.prompt).not.toContain("this note must not leak");

    // ...and it doesn't resurface on the *next* stage transition either.
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    await engine.approve(t.id);
    expect(fake.calls.at(-1)!.prompt).not.toContain("this note must not leak");
  });
});

describe("the per-task serialisation chain survives a rejection", () => {
  it("a call queued directly behind a losing one still runs its own logic, not just inherits the rejection", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");

    // All three calls fire synchronously, in the same tick, with no `await` between
    // them — p3 is issued while p2's rejection is still `taskChains`' current entry
    // for this task (the `.finally()` that would remove it only runs in a later
    // microtask). This is the scenario `prev.catch(() => {})` exists for: without it,
    // p3's `.then()` would never even call its own `advanceLocked`, and would instead
    // just inherit p2's rejection — a *different* task (cancel, always legal from any
    // non-terminal stage) makes that distinguishable from p3 genuinely running its own
    // check: if p3 merely inherited p2's failure it would reject with p2's "cannot
    // approve" message instead of fulfilling by actually cancelling the task.
    const p1 = engine.approve(t.id);       // wins: plan-review -> implementing
    const p2 = engine.approve(t.id);       // loses: implementing doesn't accept "approve" again
    const p3 = engine.cancel(t.id);        // must still run its own check and succeed

    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    expect(r3.status).toBe("fulfilled");
    expect(bugs.get(t.id).stage).toBe("cancelled");
  });
});

describe("an agent cancelled while the stage is still dispatching does not strand the task", () => {
  // `Runner.assign()` writes the assignment record, sets its own `assignmentId`, and
  // only *then* does more awaited I/O (`updateAgent`, `readMemoryIndex`) before
  // returning. A `manager.cancel()` landing inside that gap finishes the assignment
  // ("failed"/"cancelled") and fires its event while the engine has not yet recorded
  // ownership — so the event is dropped — and `assign()` then hands the engine a
  // pre-failure snapshot still reading "working". This is reachable in production
  // through POST /api/agents/:id/cancel (stop pressed while a stage dispatches).
  //
  // Deterministic by construction: rather than racing two timers, the cancel is fired
  // from inside `store.readMemoryIndex`, i.e. at a point `Runner.assign()` provably
  // reaches after creating the assignment and before returning. That is exactly the
  // interleaving the reviewer hit by racing, with no timing dependence at all.
  it("leaves the task failed with the cancellation surfaced, frees the agent, and retry() works", async () => {
    const manager = (engine as any).deps.manager as Manager;
    const realReadMemoryIndex = store.readMemoryIndex.bind(store);
    let cancelledOnce = false;
    (store as unknown as { readMemoryIndex: (id: string) => Promise<string> }).readMemoryIndex = async (agentId: string) => {
      if (!cancelledOnce) {
        cancelledOnce = true;
        await manager.cancel(agentId);   // mid-assign(): the assignment is live, the engine owns nothing yet
      }
      return realReadMemoryIndex(agentId);
    };

    const t = await engine.intake({ issueRef: "PAY-42", repo });
    expect(cancelledOnce).toBe(true);
    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/cancelled/i);

    // The agent must not be left stranded in "failed" waiting for some later ack.
    await until(() => store.getAgent(t.agentId).state === "free");

    const retried = await engine.retry(t.id);
    expect(retried.stage).toBe("analyzing");
    expect(store.getAgent(t.agentId).state).toBe("working");
  });
});

describe("an assignment that dies after the dispatch map is written is caught by its event", () => {
  // The other half of the ownership invariant. Above, the terminal write lands *before*
  // `assign()` returns, so `runStage`'s re-read catches it. Here the cancellation is
  // issued inside `assign()` but its terminal store write is held until after
  // `runStage` has recorded ownership — so the re-read sees a live "working"
  // assignment and the *event* is what must drive the task to failed. Exactly one
  // advance may result: the event path working, not merely arriving.
  //
  // Deterministic by construction: the terminal write is gated on a promise this test
  // resolves itself, so no timing assumption is made about which side wins.
  it("the event drives the task to failed exactly once, frees the agent and prunes the map", async () => {
    const manager = (engine as any).deps.manager as Manager;
    const dispatchMap = (engine as any).currentDispatch as Map<string, string>;

    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let heldOnce = false;
    const realUpdateAssignment = store.updateAssignment.bind(store);
    (store as unknown as { updateAssignment: (id: string, p: Partial<Assignment>) => Promise<Assignment> }).updateAssignment =
      async (id: string, p: Partial<Assignment>) => {
        if (!heldOnce && (p.state === "failed" || p.state === "done")) { heldOnce = true; await held; }
        return realUpdateAssignment(id, p);
      };

    const realReadMemoryIndex = store.readMemoryIndex.bind(store);
    let cancelledOnce = false;
    (store as unknown as { readMemoryIndex: (id: string) => Promise<string> }).readMemoryIndex = async (agentId: string) => {
      if (!cancelledOnce) {
        cancelledOnce = true;
        void manager.cancel(agentId).catch(() => {});   // fired, but its terminal write is held
      }
      return realReadMemoryIndex(agentId);
    };

    const t = await engine.intake({ issueRef: "PAY-42", repo });
    // Ownership recorded against an assignment that is, as far as the store knows,
    // still alive — the re-read cannot help here.
    expect(cancelledOnce).toBe(true);
    expect(t.stage).toBe("analyzing");
    expect(dispatchMap.get(t.id)).toBeTruthy();
    expect(store.getAssignment(dispatchMap.get(t.id)!).state).toBe("working");

    release();   // now let the cancellation land; only the event can catch it

    await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/cancelled/i);
    // Exactly one failure transition — not one from the event and another from anywhere else.
    expect(bugs.get(t.id).history.filter(h => h.stage === "failed")).toHaveLength(1);
    await until(() => store.getAgent(t.agentId).state === "free");
    expect(dispatchMap.has(t.id)).toBe(false);

    const retried = await engine.retry(t.id);
    expect(retried.stage).toBe("analyzing");
  });
});

/**
 * I2: the diff card shows a LIVE `git diff`, and `opening-pr` used to check only that the branch
 * differed from base and had commits — so an agent that amended or added a commit between the
 * human's approval and the push opened a PR nobody approved, and the server called that verified.
 */
describe("the approved commit is pinned", () => {
  const toDiffGate = async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    return t;
  };

  it("records the HEAD commit when the diff gate opens", async () => {
    gitState.head = "1111111111111111111111111111111111111111";
    const t = await toDiffGate();
    expect(bugs.get(t.id).approvedHead).toBe("1111111111111111111111111111111111111111");
  });

  it("fails opening-pr, naming both commits, when HEAD moved after the approval", async () => {
    gitState.head = "1111111111111111111111111111111111111111";
    const t = await toDiffGate();
    const dispatched = fake.calls.length;
    gitState.head = "2222222222222222222222222222222222222222";   // the agent amended/added a commit
    await engine.approve(t.id);
    await until(() => bugs.get(t.id).stage === "failed");
    const err = bugs.get(t.id).error ?? "";
    expect(err).toContain("1111111111111111111111111111111111111111");
    expect(err).toContain("2222222222222222222222222222222222222222");
    expect(err).toMatch(/approved/i);
    expect(fake.calls.length).toBe(dispatched);   // and no open-pr assignment was ever dispatched
  });

  it("lets opening-pr through when HEAD is still the approved commit", async () => {
    gitState.head = "1111111111111111111111111111111111111111";
    const t = await toDiffGate();
    await engine.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
  });
});

