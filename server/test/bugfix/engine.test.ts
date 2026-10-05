import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { BugFixEngine, recoverStuckBugTasks, FEEDBACK_ROUND_CAP } from "../../src/bugfix/engine.js";
import { nextStage } from "../../src/bugfix/stages.js";
import { GitOps } from "../../src/bugfix/git.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery, success } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { BugTask, PrInfo, TrackerIssue } from "../../src/bugfix/types.js";
import type { Assignment } from "../../src/types.js";
import type { QueryFn } from "../../src/runner/runner.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };

/** Fake git: records calls, pretends a worktree and commits exist. `commitsAhead`, when set,
 *  overrides `commits` — the feedback-round harness (`onMonitoringTask`, below) sets it after
 *  reaching monitoring, and it has to actually drive this mock's `commitsAhead()` rather than
 *  just look like it does. */
function fakeGit(state: { commits: number; head?: string; commitsAhead?: number; rebaseState?: { inProgress: boolean; conflicted: string[] }; removed?: Array<{ repo: string; worktree: string; branch: string }>; removeError?: string; remoteDeleted?: Array<{ dir: string; branch: string }>; deleteRemoteError?: string }) {
  const calls: string[] = [];
  state.removed ??= [];
  state.remoteDeleted ??= [];
  const g = new GitOps(async () => "");
  g.defaultBranch = async () => "main";
  g.hasRemote = async () => "git@github.com:acme/pay.git";
  g.createWorktree = async (repo, branch) => { calls.push(`create ${branch}`); const d = path.join(repo, ".worktrees", branch.replace("/", "-")); await mkdir(d, { recursive: true }); return d; };
  g.removeWorktree = async (repo, worktree, branch) => {
    calls.push("remove");
    if (state.removeError) throw new Error(state.removeError);
    state.removed!.push({ repo, worktree, branch });
    // The real GitOps.removeWorktree deletes the directory; a fake that only records the
    // call would leave it on disk, and a later `intake()` reusing the same issue key (e.g. a
    // second `atMergeGate()`/`onMonitoringTask()` call in the same test) would then trip the
    // "leftover worktree" guard against a worktree this fake claims it already tore down.
    await rm(worktree, { recursive: true, force: true });
  };
  g.deleteRemoteBranch = async (dir, branch) => {
    calls.push("delete-remote");
    if (state.deleteRemoteError) throw new Error(state.deleteRemoteError);
    state.remoteDeleted!.push({ dir, branch });
  };
  g.currentBranch = async () => "bugfix/PAY-42";
  g.revParse = async () => state.head ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  g.commitsAhead = async () => state.commitsAhead ?? state.commits;
  g.diff = async () => ({ patch: "diff --git a/a b/a\n+x\n", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 });
  g.worktreeRegistered = async () => false;
  g.branchExists = async () => false;
  g.rebaseState = async () => state.rebaseState ?? { inProgress: false, conflicted: [] };
  return { git: g, calls };
}

const forge = {
  name: "github",
  // Mutable merge-tracking state, reset in `beforeEach` below — shared by every test that
  // uses the default `forge` (rather than `atMergeGate`'s own override), including the
  // "externally merged" path which drives this same object directly.
  merges: [] as Array<{ number: number; method: string }>,
  mergeResult: { ok: true, message: "merged (fake)" } as { ok: boolean; message: string },
  state: "OPEN" as "OPEN" | "MERGED" | "CLOSED",
  stateAfterMerge: "MERGED" as "OPEN" | "MERGED" | "CLOSED",
  authStatus: async () => ({ ok: true, message: "ok" }),
  createPr: async () => ({ found: { number: 7, url: "https://x/pr/7", state: forge.state, reviewDecision: null, checks: null, mergeable: "MERGEABLE" as string | null, headSha: "abc1234", lastSeenEventAt: "t" } }),
  findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: "abc1234", lastSeenEventAt: "t" }),
  getPr: async () => ({ found: { number: 7, url: "https://x/pr/7", state: forge.state, reviewDecision: null, checks: null, mergeable: "MERGEABLE" as string | null, headSha: "abc1234", lastSeenEventAt: "t" } }),
  listReviewEvents: async () => [],
  merge: async (_repo: string, number: number, method: string) => {
    forge.merges.push({ number, method });
    if (forge.mergeResult.ok) forge.state = forge.stateAfterMerge;
    return forge.mergeResult;
  },
};

let home: string; let repo: string; let store: Store; let bugs: BugTaskStore; let fake: ReturnType<typeof makeFakeQuery>;
let engine: BugFixEngine; let comments: Array<[string, string]>;
let gitState: { commits: number; head?: string; commitsAhead?: number; rebaseState?: { inProgress: boolean; conflicted: string[] }; removed?: Array<{ repo: string; worktree: string; branch: string }>; removeError?: string; remoteDeleted?: Array<{ dir: string; branch: string }>; deleteRemoteError?: string };

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
  // Reset the shared default forge's mutable merge-tracking state between tests.
  forge.merges = [];
  forge.mergeResult = { ok: true, message: "merged (fake)" };
  forge.state = "OPEN";
  forge.stateAfterMerge = "MERGED";
  engine = new BugFixEngine({
    store, bugs, manager: new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
    git: fakeGit(gitState).git, integrations: new IntegrationsStore(home),
    tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async (k, t) => { comments.push([k, t]); } },
    forge, presetsDir: path.resolve("presets"),
  });
  engine.attach();
});

const finishStage = async (f: ReturnType<typeof makeFakeQuery> = fake) => {
  // The most recently created task is the one whose stage this dispatch is progressing.
  // Waiting for its stage to actually move (rather than just pushing the fake stream's
  // messages) is what lets callers inspect task state immediately afterwards without an
  // explicit `until()` of their own — the assignment-finished pipeline (store writes,
  // agent-state catch-up, `verify()`, the resulting transition) runs across several real
  // timers and microtasks that a fixed delay would not reliably outlast.
  const t = bugs.list().at(-1);
  const before = t?.stage;
  f.emit(success("done"));
  f.end();
  if (t) await until(() => bugs.get(t.id).stage !== before, 2000);
};

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

  it("refuses to re-launch the same ticket while its worktree is still registered, naming the path and what to run", async () => {
    const { git: g, calls } = fakeGit(gitState);
    g.worktreeRegistered = async () => true;
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    let message = "";
    await e2.intake({ issueRef: "PAY-42", repo }).catch(err => { message = (err as Error).message; });
    expect(message).toMatch(/worktree.*bugfix-PAY-42.*worktree remove --force/s);
    expect(message).not.toContain("rm -rf");        // registered — the real `git worktree remove` works, don't suggest rm -rf
    expect(message).not.toContain("branch -D");      // only the worktree is leftover here, not the branch — don't suggest deleting a branch that doesn't exist
    expect(calls).not.toContain("create bugfix/PAY-42"); // never got as far as `git worktree add`
  });

  it("refuses to re-launch the same ticket while its branch still exists, naming the branch and what to run", async () => {
    const { git: g, calls } = fakeGit(gitState);
    g.branchExists = async () => true;
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    let message = "";
    await e2.intake({ issueRef: "PAY-42", repo }).catch(err => { message = (err as Error).message; });
    expect(message).toMatch(/branch.*bugfix\/PAY-42.*branch -D bugfix\/PAY-42/s);
    expect(message).not.toContain("worktree remove");   // no leftover worktree — nothing to remove
    expect(message).not.toContain("rm -rf");
    expect(calls).not.toContain("create bugfix/PAY-42");
  });

  // N2: a leftover directory `git worktree list` doesn't know about any more (metadata
  // pruned/lost some other way) is a THIRD shape distinct from "registered worktree" — and
  // printing `git worktree remove --force` for it hands the user a command that itself
  // fails ("fatal: ... is not a working tree"), landing them right back in the raw error
  // this whole check exists to prevent.
  it("refuses to re-launch while a worktree directory exists on disk but git has no record of it, suggesting rm -rf instead of worktree remove", async () => {
    const { git: g, calls } = fakeGit(gitState);
    g.worktreeRegistered = async () => false;   // git doesn't know about it...
    const dir = path.join(repo, ".worktrees", "bugfix-PAY-42");
    await mkdir(dir, { recursive: true });      // ...but the directory is still there
    const e2 = new BugFixEngine({ ...(engine as any).deps, git: g });
    let message = "";
    await e2.intake({ issueRef: "PAY-42", repo }).catch(err => { message = (err as Error).message; });
    expect(message).toContain(dir);
    expect(message).toContain(`rm -rf ${dir}`);
    expect(message).not.toContain("worktree remove");   // `git worktree remove` would fail on this directory
    expect(calls).not.toContain("create bugfix/PAY-42");
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
    await bugs.writeArtifact(t.id, "pr-body.md", `PR body.\n\nFixes ${ISSUE.url}`);
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
    expect(bugs.get(t.id).pr).toMatchObject({ number: 7, url: "https://x/pr/7" });
    expect(comments).toEqual([["PAY-42", expect.stringContaining("https://x/pr/7")]]);
  });

  it("creating-pr fails when the forge cannot create the PR", async () => {
    // Fully independent engine (own store/bugs/manager/fake) so this test exercises the
    // createPr()-returns-unavailable failure path itself, not the ownership scoping that
    // keeps a second, differently-configured engine on the *same* store from racing this one.
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
      forge: { ...forge, createPr: async () => ({ unavailable: "gh: could not create the pull request" }) }, presetsDir: path.resolve("presets"),
    });
    e2.attach();
    const finishStage2 = async () => { fake2.emit(success("done")); fake2.end(); };

    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs2.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "plan-review");
    await e2.approve(t.id); gitState2.commits = 1;
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "diff-review");
    await e2.approve(t.id);
    await bugs2.writeArtifact(t.id, "pr-body.md", "PR body");
    await finishStage2(); await until(() => bugs2.get(t.id).stage === "failed");
    expect(bugs2.get(t.id).error).toMatch(/could not create the pull request/i);
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

describe("creating-pr requires an OPEN pull request", () => {
  async function toDiffReview(e: BugFixEngine): Promise<BugTask> {
    const t = await e.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await e.approve(t.id);
    gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    return t;
  }

  it("fails the stage instead of advancing when the forge reports a MERGED pull request", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, createPr: async () => ({ found: { number: 7, url: "https://gh/pr/7", state: "MERGED" as const, reviewDecision: null, checks: null, mergeable: null, headSha: "abc1234", lastSeenEventAt: "t" } }) } });
    e2.attach();
    const t = await toDiffReview(e2);
    await e2.approve(t.id);
    await bugs.writeArtifact(t.id, "pr-body.md", "PR body");
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/merged/i);
    expect(bugs.get(t.id).error).toMatch(/#7/);
  });

  it("fails the stage instead of advancing when the forge reports a CLOSED pull request", async () => {
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, createPr: async () => ({ found: { number: 7, url: "https://gh/pr/7", state: "CLOSED" as const, reviewDecision: null, checks: null, mergeable: null, headSha: "abc1234", lastSeenEventAt: "t" } }) } });
    e2.attach();
    const t = await toDiffReview(e2);
    await e2.approve(t.id);
    await bugs.writeArtifact(t.id, "pr-body.md", "PR body");
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/closed/i);
    expect(bugs.get(t.id).error).toMatch(/#7/);
  });

  it("an OPEN pull request still advances to monitoring", async () => {
    const t = await toDiffReview(engine);
    await engine.approve(t.id);
    await bugs.writeArtifact(t.id, "pr-body.md", "PR body");
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
    // Simulate a restart: `start.ts` runs `Manager.recoverOnStart()` (frees the stuck
    // agent) and `recoverStuckBugTasks()` (fails any task left mid-stage) before any
    // `BugFixEngine` is even built — a fresh engine instance over the same durable
    // stores, with no in-memory state at all, then sees the already-recovered task.
    const deps = (engine as any).deps;
    await deps.manager.recoverOnStart();
    await recoverStuckBugTasks(deps.bugs);
    expect(bugs.get(t.id).stage).toBe("failed");
    expect(bugs.get(t.id).error).toMatch(/restart/i);

    const fresh = new BugFixEngine(deps);
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
    await bugs.writeArtifact(t.id, "pr-body.md", "PR body");
    await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");
  });

  // N1: runStage's revParse check only runs BEFORE dispatch. An agent that commits inside
  // the worktree during the opening-pr run itself (and pushes) moved HEAD after that check
  // passed. Task 3 moved the re-check from `verify()` into `doCreatePr` (the "creating-pr"
  // server stage that runs right after opening-pr's own verify passes) — it now fires there,
  // immediately before the push, rather than as part of verifying the agent's own stage.
  it("fails, naming both commits, when HEAD moves DURING the run (after dispatch, before the push)", async () => {
    gitState.head = "1111111111111111111111111111111111111111";
    const t = await toDiffGate();
    await engine.approve(t.id);   // pre-dispatch pin check passes: HEAD is still 1111...
    gitState.head = "3333333333333333333333333333333333333333";   // agent commits+pushes mid-run
    await bugs.writeArtifact(t.id, "pr-body.md", "PR body");
    await finishStage();
    await until(() => bugs.get(t.id).stage === "failed");
    const err = bugs.get(t.id).error ?? "";
    expect(err).toContain("1111111111111111111111111111111111111111");
    expect(err).toContain("3333333333333333333333333333333333333333");
    expect(err).toMatch(/approved/i);
    expect(bugs.get(t.id).pr).toBeNull();   // never recorded as verified
  });
});

/**
 * Drives a fresh task all the way to `monitoring` with a PR recorded, for the feedback-round
 * tests below. Follows the existing harness's shape — it reuses the outer `engine`/`bugs`/
 * `fake`/`gitState` that `beforeEach` already built, rather than standing up a second engine.
 *
 * `gitState.head` is pinned to a fixed sentinel ("aaa") for the whole run up to monitoring, so
 * `approvedHead` — pinned by `implementing`'s own verify step — ends up equal to it. That's what
 * lets a test simply assert `gitState.head = "aaa"` afterwards to mean "nothing changed": it's
 * already what the task approved, not a coincidence of some unrelated default.
 */
async function onMonitoringTask() {
  // Collects every "bugtask" event the store emits from here on — used by the notification
  // tests to pin that a stage transition actually reaches the stream the UI listens on, not
  // just that `bugs.get()` reflects the new stage.
  const seen: Array<{ type: string; task: BugTask }> = [];
  bugs.on("event", (e: any) => { if (e?.type === "bugtask") seen.push(e); });

  gitState.head = "aaa";
  const t = await engine.intake({ issueRef: "PAY-42", repo });
  await bugs.writeArtifact(t.id, "plan.md", "# Plan");
  await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
  await engine.approve(t.id);
  gitState.commits = 1;
  await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
  await engine.approve(t.id);
  await bugs.writeArtifact(t.id, "pr-body.md", `PR body.\n\nFixes ${ISSUE.url}`);
  await finishStage(); await until(() => bugs.get(t.id).stage === "monitoring");

  const task = bugs.get(t.id);
  const gs = gitState as typeof gitState & { commitsAhead: number; prHead: string; pr: PrInfo };
  gs.commitsAhead = gs.commits;
  gs.prHead = gs.head!;
  // `pr` is a getter, not a snapshot: it always reflects the current `prHead` as `headSha`, so
  // a test that sets `gitState.prHead` and then reads (or passes on) `gitState.pr` genuinely
  // sees that change, rather than the two fields being independent and one of them decorative.
  Object.defineProperty(gs, "pr", {
    configurable: true,
    get(): PrInfo { return { ...task.pr!, headSha: gs.prHead }; },
  });
  return { engine, bugs, fake, gitState: gs, seen };
}

describe("a feedback round", () => {
  it("dispatches review-feedback, verifies new commits, and opens a labelled diff gate", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "review-changes-requested", comments: "fix the leak" } });
    expect(bugs.get("bt1").stage).toBe("review-feedback");
    expect(bugs.get("bt1").feedbackRounds).toBe(1);
    gitState.commitsAhead = 2; gitState.head = "bbb";
    await finishStage(fake);
    const t = bugs.get("bt1");
    expect(t.stage).toBe("diff-review");
    expect(t.gate).toMatchObject({ kind: "diff", reason: "feedback" });
    expect(t.approvedHead).toBe("bbb");                                  // re-pinned for this round
  });

  it("fails the round when the agent produced no new commits", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    gitState.prHead = "aaa"; gitState.head = "aaa";                      // nothing new
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "review-changes-requested", comments: "fix it" } });
    await finishStage(fake);
    const t = bugs.get("bt1");
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/no new commits/i);
  });

  it("stops dispatching after the cap and reports it instead", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await bugs.patch("bt1", { feedbackRounds: FEEDBACK_ROUND_CAP });
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "review-changes-requested", comments: "again" } });
    const t = bugs.get("bt1");
    expect(t.stage).toBe("monitoring");                                  // no agent dispatched
    expect(t.error).toMatch(/feedback rounds/i);
  });

  // The cap exists to stop the WATCHER spending unattended, not to single out one kind of
  // finding — a PR whose CI keeps failing after every round is exactly the pathological case
  // the cap is for, and previously it dispatched forever because only "review-changes-requested"
  // was checked against it while "checks-failed" (which also routes to review-feedback, per
  // stages.ts) was advanced unconditionally.
  it("stops dispatching a checks-failed finding after the cap too, and reports it the same way", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await bugs.patch("bt1", { feedbackRounds: FEEDBACK_ROUND_CAP });
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "checks-failed", checks: "checks are failing", headSha: "aaa" } });
    const t = bugs.get("bt1");
    expect(t.stage).toBe("monitoring");                                  // no agent dispatched
    expect(t.error).toMatch(/feedback rounds/i);
  });

  // The engine is the only writer of task state, so the head the watcher must dedupe against is
  // recorded here, at dispatch — and only once the transition has been accepted.
  it("records the head a checks-failed round was dispatched at", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    expect(bugs.get("bt1").checksRoundHead).toBeNull();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "checks-failed", checks: "red", headSha: "ccc" } });
    expect(bugs.get("bt1").stage).toBe("review-feedback");
    expect(bugs.get("bt1").checksRoundHead).toBe("ccc");
  });

  it("records nothing when the checks-failed event is refused — the cap already stopped the round", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await bugs.patch("bt1", { feedbackRounds: FEEDBACK_ROUND_CAP });
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "checks-failed", checks: "red", headSha: "ccc" } });
    expect(bugs.get("bt1").checksRoundHead).toBeNull();
  });

  // The other half of the fix: under the cap, a checks-failed finding must still dispatch —
  // the cap gates the round budget, not this particular event type.
  it("still dispatches review-feedback for a checks-failed finding when under the cap", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "checks-failed", checks: "checks are failing", headSha: "aaa" } });
    const t = bugs.get("bt1");
    expect(t.stage).toBe("review-feedback");
    expect(t.feedbackRounds).toBe(1);
  });

  it("records the latest PR view even when there is nothing to do", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    const pr = { ...gitState.pr, lastSeenEventAt: "2026-09-26T10:00:00Z", checks: "PENDING" };
    await engine.onPrFinding({ taskId: "bt1", pr, event: null });
    expect(bugs.get("bt1").pr).toMatchObject({ checks: "PENDING", lastSeenEventAt: "2026-09-26T10:00:00Z" });
    expect(bugs.get("bt1").stage).toBe("monitoring");
  });

  // I3: the warn tick patches the error and nothing reported recovery, so a three-tick blip left
  // the message on the card until some later transition happened to clear it.
  it("clears the forge-unreachable note as soon as a poll succeeds again", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: null, unavailable: "gh: could not connect" });
    expect(bugs.get("bt1").error).toMatch(/could not check/i);
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, checks: "PENDING" }, event: null, checkedAt: "2026-09-27T10:00:00Z" });
    expect(bugs.get("bt1").error).toBeNull();
  });

  it("clears it on a quiet tick too, and records when that tick happened", async () => {
    const { engine, bugs } = await onMonitoringTask();
    // `doCreatePr` (Task 3) already recorded a real "now" via `patchPr` on the way to
    // monitoring — reset it so this test's own fixed timestamp is unambiguously later.
    await bugs.patch("bt1", { prCheckedAt: null });
    await engine.onPrFinding({ taskId: "bt1", pr: null, event: null, unavailable: "gh: could not connect" });
    expect(bugs.get("bt1").error).toMatch(/could not check/i);
    await engine.onPrChecked("bt1", "2026-09-27T10:00:00Z");
    expect(bugs.get("bt1").error).toBeNull();
    expect(bugs.get("bt1").prCheckedAt).toBe("2026-09-27T10:00:00Z");
  });

  it("leaves an error that is not about reaching the forge alone — the cap message must survive a poll", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    await bugs.patch("bt1", { feedbackRounds: FEEDBACK_ROUND_CAP });
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "checks-failed", checks: "still failing", headSha: "aaa" } });
    const capped = bugs.get("bt1").error;
    expect(capped).toMatch(/feedback rounds/i);
    await engine.onPrChecked("bt1", "2026-09-27T10:00:00Z");
    expect(bugs.get("bt1").error).toBe(capped);
  });

  it("does not advance the poll time when the forge could not be read", async () => {
    const { engine, bugs } = await onMonitoringTask();
    // Same reset as the test above — `doCreatePr` already set a real "now" on the way here.
    await bugs.patch("bt1", { prCheckedAt: null });
    await engine.onPrChecked("bt1", "2026-09-27T10:00:00Z");
    await engine.onPrFinding({ taskId: "bt1", pr: bugs.get("bt1").pr, event: null, unavailable: "gh: down", checkedAt: "2026-09-27T10:05:00Z" });
    expect(bugs.get("bt1").prCheckedAt).toBe("2026-09-27T10:00:00Z");
  });

  // item 4: the "forge unreachable" branch — no event, but a reason the watcher couldn't check
  // must still land on the task, without touching its stage or dispatching anything.
  it("records the unavailable error without dispatching or changing stage", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    const callsBefore = fake.calls.length;
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: null, unavailable: "gh: rate limited" });
    const t = bugs.get("bt1");
    expect(t.stage).toBe("monitoring");
    expect(t.error).toMatch(/could not check the pull request.*rate limited/i);
    expect(fake.calls.length).toBe(callsBefore);   // no agent dispatched
  });
});

/**
 * Lands a fresh task (via `onMonitoringTask`) at a labelled diff-review gate — the state a
 * feedback round or a rebase round leaves it in once the human's next look is due. `pushing`
 * is a SERVER_STAGES stage, dispatched by the engine itself rather than an agent, so the
 * transition that gets it there needs no agent stage actually completing — the "rebase" agent
 * stage in particular has no preset/prompt of its own yet in this codebase, so its round is
 * driven directly through the store the same shape `nextStage`'s own `wait(...)` produces:
 * one history entry naming the round's agent stage ("review-feedback" or "rebase" — what
 * `doPush` reads to decide `force`, since the gate itself is cleared by the time `doPush`
 * runs), then the diff-review gate carrying that reason.
 *
 * Also wires up push tracking on the fake git (`gitState.pushes`, `gitState.pushError`) and a
 * forge whose `prHead` is a plain mutable property, so a test can move it after the gate opens
 * exactly the way a real `gh` poll would report a new head after the push actually lands.
 */
async function atFeedbackDiffGate(opts: { reason?: "feedback" | "rebase" } = {}) {
  const reason = opts.reason ?? "feedback";
  const { engine, bugs, fake, gitState } = await onMonitoringTask();
  const gs = gitState as typeof gitState & {
    pushes: Array<{ dir: string; branch: string; force: boolean }>;
    pushError?: string;
  };
  gs.pushes = [];
  const deps = (engine as any).deps;
  deps.git.push = async (dir: string, branch: string, o: { force?: boolean } = {}) => {
    if (gs.pushError) throw new Error(gs.pushError);
    gs.pushes.push({ dir, branch, force: !!o.force });
  };

  const forge: any = {
    name: "github",
    prHead: gs.head,
    authStatus: async () => ({ ok: true, message: "ok" }),
    createPr: async () => ({ found: { number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: forge.prHead, lastSeenEventAt: "t" } }),
    findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: forge.prHead, lastSeenEventAt: "t" }),
    getPr: async () => ({ found: { number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: forge.prHead, lastSeenEventAt: "t" } }),
    listReviewEvents: async () => [],
    merge: async () => ({ ok: true, message: "merged (fake)" }),
  };
  deps.forge = forge;

  // What the round actually approved — the commit `doPush`'s pin check must see HEAD still at.
  const head = reason === "rebase" ? "ccc" : "bbb";
  gs.head = head;
  forge.prHead = head;
  await bugs.apply("bt1", { stage: reason, run: reason, gate: null, note: "", error: null });
  await bugs.patch("bt1", { approvedHead: head });
  await bugs.apply("bt1", { stage: "diff-review", run: null, gate: { kind: "diff", openedAt: new Date().toISOString(), reason }, note: "", error: null });

  return { engine, bugs, gitState: gs, forge };
}

describe("the server pushes an approved feedback diff", () => {
  it("pushes, confirms the PR head moved, and returns to monitoring", async () => {
    const { engine, bugs, gitState, forge } = await atFeedbackDiffGate();
    gitState.head = "bbb";
    forge.prHead = "bbb";                                                    // the PR will report the new head
    await engine.approve("bt1");
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    const t = bugs.get("bt1");
    expect(gitState.pushes).toEqual([{ dir: t.worktree, branch: t.branch, force: false }]);
    expect(t.stage).toBe("monitoring");
    expect(t.error).toBeNull();
  });

  it("force-pushes with a lease after a rebase, and only then", async () => {
    const { engine, bugs, gitState, forge } = await atFeedbackDiffGate({ reason: "rebase" });
    gitState.head = "ccc"; forge.prHead = "ccc";
    await engine.approve("bt1");
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    expect(gitState.pushes[0]).toMatchObject({ force: true });
  });

  it("refuses to push when the branch moved after approval", async () => {
    const { engine, bugs, gitState } = await atFeedbackDiffGate();
    gitState.head = "zzz";                                                   // moved since the gate opened
    await engine.approve("bt1");
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    const t = bugs.get("bt1");
    expect(gitState.pushes).toEqual([]);
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/moved since the diff was approved/i);
  });

  it("fails the stage with git's message when the push is rejected", async () => {
    const { engine, bugs, gitState } = await atFeedbackDiffGate();
    gitState.head = "bbb";
    gitState.pushError = "git push failed: ! [rejected] bugfix/W-1 -> bugfix/W-1 (non-fast-forward)";
    await engine.approve("bt1");
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    expect(bugs.get("bt1").stage).toBe("failed");
    expect(bugs.get("bt1").error).toMatch(/non-fast-forward/);
  });

  it("fails when the PR head did not move, rather than resting on a push that did nothing", async () => {
    const { engine, bugs, gitState, forge } = await atFeedbackDiffGate();
    gitState.head = "bbb"; forge.prHead = "aaa";                             // PR still on the old head
    await engine.approve("bt1");
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    expect(bugs.get("bt1").stage).toBe("failed");
    expect(bugs.get("bt1").error).toMatch(/pull request .* still/i);
  });
});

describe("a rebase round", () => {
  it("dispatches rebase on a conflict and opens a diff gate labelled rebase", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, mergeable: "CONFLICTING" }, event: { type: "conflicting" } });
    expect(bugs.get("bt1").stage).toBe("rebase");
    gitState.head = "ddd"; gitState.commitsAhead = 1;
    await finishStage(fake);
    expect(bugs.get("bt1").gate).toMatchObject({ kind: "diff", reason: "rebase" });
  });

  it("fails the stage when the rebase was left half-finished or conflicted", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "conflicting" } });
    gitState.rebaseState = { inProgress: true, conflicted: ["src/a.ts"] };
    await finishStage(fake);
    const t = bugs.get("bt1");
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/rebase is not finished|conflict/i);
    expect(t.error).toContain("src/a.ts");
  });

  // The dependency Task 6 left open: a rebase legitimately moves HEAD, so `verify()`'s
  // "rebase" branch must re-pin `approvedHead` to the post-rebase head — otherwise the
  // eventual push's own pin check ("the branch moved since the diff was approved") fails
  // every real rebase, since HEAD is (correctly) no longer what it was before the rebase.
  it("re-pins approvedHead to the post-rebase head, so the subsequent push does not trip the pin", async () => {
    const { engine, bugs, fake, gitState } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "conflicting" } });
    gitState.head = "ddd"; gitState.commitsAhead = 1;
    await finishStage(fake);
    let t = bugs.get("bt1");
    expect(t.stage).toBe("diff-review");
    expect(t.approvedHead).toBe("ddd");   // re-pinned to the post-rebase head, not the pre-rebase one

    const deps = (engine as any).deps;
    const pushes: Array<{ dir: string; branch: string; force: boolean }> = [];
    deps.git.push = async (dir: string, branch: string, o: { force?: boolean } = {}) => { pushes.push({ dir, branch, force: !!o.force }); };
    deps.forge = {
      ...forge,
      getPr: async () => ({ found: { number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: "ddd", lastSeenEventAt: "t" } }),
    };

    await engine.approve("bt1");   // HEAD is still "ddd" — the pin must NOT reject this
    await until(() => bugs.get("bt1").stage !== "pushing", 2000);
    t = bugs.get("bt1");
    expect(t.error).toBeNull();
    expect(t.stage).toBe("monitoring");
    expect(pushes).toEqual([{ dir: t.worktree, branch: t.branch, force: true }]);   // rebase => lease force
  });
});


/**
 * Lands a fresh task at the merge gate (`approved`, `gate.kind === "merge"`) via the same
 * "review-approved" finding a real watcher would report from `monitoring`. Overrides the
 * engine's forge with a mutable merge-tracking fake and the tracker with one whose failure
 * can be toggled per test, mirroring `atFeedbackDiffGate`'s shape.
 */
async function atMergeGate() {
  const { engine, bugs, gitState, seen } = await onMonitoringTask();
  const deps = (engine as any).deps;

  const mergeForge: any = {
    name: "github",
    merges: [] as Array<{ number: number; method: string }>,
    mergeResult: { ok: true, message: "merged (fake)" },
    state: "OPEN" as "OPEN" | "MERGED" | "CLOSED",
    stateAfterMerge: "MERGED" as "OPEN" | "MERGED" | "CLOSED",
    // Overrides the *second* `getPr` call only (the post-merge confirmation) — the first call
    // is the pre-merge "is this already merged" read, which every test still needs to behave
    // normally so the merge itself actually happens. Lets a test simulate a flaky/absent
    // confirmation read without touching the pre-merge read at all.
    afterResult: null as null | { unavailable: string } | { found: null },
    getPrCalls: 0,
    authStatus: async () => ({ ok: true, message: "ok" }),
    createPr: async () => ({ found: { number: 7, url: "https://x/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: gitState.head, lastSeenEventAt: "t" } }),
    findPr: async () => ({ number: 7, url: "https://x/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: gitState.head, lastSeenEventAt: "t" }),
    getPr: async () => {
      mergeForge.getPrCalls++;
      if (mergeForge.getPrCalls === 2 && mergeForge.afterResult) return mergeForge.afterResult;
      return { found: { number: 7, url: "https://x/pr/7", state: mergeForge.state, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: gitState.head, lastSeenEventAt: "t" } };
    },
    listReviewEvents: async () => [],
    merge: async (_repo: string, number: number, method: string) => {
      mergeForge.merges.push({ number, method });
      if (mergeForge.mergeResult.ok) mergeForge.state = mergeForge.stateAfterMerge;
      return mergeForge.mergeResult;
    },
  };
  deps.forge = mergeForge;

  const mergeTracker: any = {
    fail: false,
    comments: [] as Array<{ key: string; text: string }>,
    listMyIssues: async () => [],
    fetchIssue: async () => ISSUE,
    comment: async (key: string, text: string) => {
      if (mergeTracker.fail) throw new Error("tracker unavailable");
      mergeTracker.comments.push({ key, text });
    },
  };
  deps.tracker = mergeTracker;

  const taskId = bugs.list().at(-1)!.id;
  await engine.onPrFinding({ taskId, pr: { ...gitState.pr, state: "OPEN" }, event: { type: "review-approved" } });
  await until(() => bugs.get(taskId).stage === "approved");

  return { engine, bugs, forge: mergeForge, gitState, store, tracker: mergeTracker, taskId, seen };
}

describe("merging", () => {
  it("merges with the recorded method, confirms MERGED, tears down, and lands on done", async () => {
    const { engine, bugs, forge, gitState, store, taskId } = await atMergeGate();
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(forge.merges).toEqual([{ number: 7, method: "squash" }]);
    expect(t.stage).toBe("done");
    expect(t.pr).toMatchObject({ state: "MERGED" });
    expect(gitState.removed).toEqual([{ repo: t.sourceRepo, worktree: t.worktree, branch: t.branch }]);
    expect(store.getAgent(t.agentId)?.state).toBe("free");
    expect(t.error).toBeNull();
  });

  /**
   * C4: the merge call used to pass `gh pr merge --delete-branch`, which also deletes the LOCAL
   * branch — and the task branch is checked out in the linked worktree, so git refuses and gh
   * exits non-zero. An irreversible merge that actually happened then presented as "Stage
   * failed". The remote branch is deleted here instead, once the merge is confirmed, where the
   * worst a failure can do is add a line to the cleanup note.
   */
  it("deletes the remote branch itself, after the merge is confirmed", async () => {
    const { engine, bugs, gitState, taskId } = await atMergeGate();
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("done");
    expect(gitState.remoteDeleted).toEqual([{ dir: t.sourceRepo, branch: t.branch }]);
    expect(t.error).toBeNull();
  });

  it("turns a failed remote-branch deletion into a cleanup note, never a failed merge", async () => {
    const { engine, bugs, gitState, taskId } = await atMergeGate();
    gitState.deleteRemoteError = "remote rejected the delete (protected branch)";
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("done");
    expect(t.outcome).toBe("merged");
    expect(t.error).toMatch(/protected branch/);
    expect(t.error).toContain(t.branch);              // says which branch is still out there
    expect(gitState.removed).toHaveLength(1);         // and the rest of teardown still ran
  });

  it("honours a method chosen at the gate", async () => {
    const { engine, bugs, forge, taskId } = await atMergeGate();
    await engine.mergeTask(taskId, "merge");
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    expect(forge.merges[0]).toMatchObject({ method: "merge" });
  });

  it("fails the stage with the forge's reason and does not tear anything down", async () => {
    const { engine, bugs, forge, gitState, taskId } = await atMergeGate();
    forge.mergeResult = { ok: false, message: "Pull request is not mergeable" };
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    expect(bugs.get(taskId).stage).toBe("failed");
    expect(bugs.get(taskId).error).toMatch(/not mergeable/i);
    expect(gitState.removed).toEqual([]);
  });

  it("refuses to tear down when the PR does not actually read as MERGED afterwards", async () => {
    const { engine, bugs, forge, gitState, taskId } = await atMergeGate();
    forge.stateAfterMerge = "OPEN";                       // the merge call lied, or raced
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    expect(bugs.get(taskId).stage).toBe("failed");
    expect(gitState.removed).toEqual([]);
  });

  it("still reaches done when cleanup fails, and says what is left behind", async () => {
    const { engine, bugs, gitState, taskId } = await atMergeGate();
    gitState.removeError = "worktree cleanup incomplete: branch -D failed";
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("done");                         // the merge is a fact; do not hide it
    expect(t.outcome).toBe("merged");                     // and it stays a merge, leftovers or not
    expect(t.error).toMatch(/cleanup incomplete/i);
    expect(t.error).toContain(t.worktree);
  });

  it("comments the PR link on the ticket, and a tracker failure does not undo the merge", async () => {
    const { engine, bugs, tracker, taskId } = await atMergeGate();
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    expect(tracker.comments[0]).toMatchObject({ key: "PAY-42" });
    expect(tracker.comments[0].text).toContain("https://x/pr/7");

    const second = await atMergeGate();
    second.tracker.fail = true;
    await second.engine.approve(second.taskId);
    await until(() => second.bugs.get(second.taskId).stage !== "merging", 2000);
    expect(second.bugs.get(second.taskId).stage).toBe("done");
  });

  /**
   * C2: the watcher writes the PR view outside `advance()`'s per-task chain, and `approved` is a
   * watched stage — so a tick whose `getPr` was already in flight when the human clicked Merge
   * can resolve in the middle of `doMerge`, after its bookkeeping has landed. Held open at
   * exactly that point here, rather than left to timing.
   */
  it("a tick already in flight when the human merged cannot write its pre-merge view over the merged one", async () => {
    const { engine, bugs, gitState, taskId } = await atMergeGate();
    const deps = (engine as any).deps;
    const stale = { ...gitState.pr, state: "OPEN" as const };
    const staleCheckedAt = new Date(Date.now() - 60_000).toISOString();   // read a minute before the merge

    // Hold teardown open: by the time `removeWorktree` runs, `doMerge` has already recorded the
    // MERGED view, which is precisely the write the stale tick must not undo.
    let entered = false;
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    const origRemove = deps.git.removeWorktree.bind(deps.git);
    deps.git.removeWorktree = async (...args: unknown[]) => { entered = true; await held; return origRemove(...args); };

    const merging = engine.approve(taskId);
    await until(() => entered, 2000);
    await engine.onPrFinding({ taskId, pr: stale, checkedAt: staleCheckedAt, event: null });
    release();
    await merging;
    await until(() => bugs.get(taskId).stage === "done", 2000);

    const t = bugs.get(taskId);
    expect(t.pr).toMatchObject({ state: "MERGED" });
    // And the durable outcome says so too, independently of the PR view.
    expect(t.outcome).toBe("merged");
  });

  it("an externally merged PR reaches done through the same path, without calling merge", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    forge.state = "MERGED";
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, state: "MERGED" }, event: { type: "pr-merged" } });
    await until(() => bugs.get("bt1").stage !== "merging", 2000);
    expect(forge.merges).toEqual([]);                     // nothing to merge — it already is
    expect(bugs.get("bt1").stage).toBe("done");
    expect(gitState.removed).toHaveLength(1);
  });

  // The design point item 1 exists for: `pr-merged` enters "merging" with no gate at all
  // (straight from "monitoring"), so a watcher/adapter that misreports MERGED on a PR that
  // is actually still open must never cause a real merge — it can only confirm, and must
  // fail the stage when there is nothing to confirm.
  it("an externally reported merge that isn't actually merged yet fails the stage without ever calling merge", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    forge.state = "OPEN";   // the watcher's pr-merged finding was wrong, or raced
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, state: "MERGED" }, event: { type: "pr-merged" } });
    await until(() => bugs.get("bt1").stage !== "merging", 2000);
    expect(forge.merges).toEqual([]);                      // the ungated path may never merge
    expect(bugs.get("bt1").stage).toBe("failed");
    expect(bugs.get("bt1").error).toMatch(/has not merged yet|refusing to merge/i);
    expect(gitState.removed).toEqual([]);
  });

  // Items 4: the confirmation reads that matter most on this irreversible path are the ones
  // that don't come back with a clean "found and MERGED" — both fakes previously always
  // returned `{ found: ... }`, so neither PrLookup shape below was ever actually exercised.
  it("fails the stage and tears down nothing when the post-merge confirmation is unavailable", async () => {
    const { engine, bugs, forge, gitState, taskId } = await atMergeGate();
    forge.afterResult = { unavailable: "gh: rate limited" };
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(forge.merges).toEqual([{ number: 7, method: "squash" }]);   // the merge call itself did happen
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/did not come back merged.*rate limited/i);
    expect(gitState.removed).toEqual([]);
  });

  it("fails the stage and tears down nothing when the post-merge confirmation finds no PR", async () => {
    const { engine, bugs, forge, gitState, taskId } = await atMergeGate();
    forge.afterResult = { found: null };
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(forge.merges).toEqual([{ number: 7, method: "squash" }]);
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/did not come back merged/i);
    expect(gitState.removed).toEqual([]);
  });

  // Item 1, round 2: `retry` re-enters "merging" directly (a SERVER_STAGES stage, per
  // stages.ts's `retry` case), stacking a "failed" on top of whatever originally gated the
  // attempt. The entry-route discriminator must see past that "failed" (and the "merging" it
  // sits on) to the "approved" underneath, or a gated merge that failed for a fixable reason
  // (e.g. "not mergeable" because of an unrelated conflicting PR that has since been dealt
  // with) could never be retried — the only ways out would be merging in the browser or
  // dismissing the task outright.
  it("a gated merge that failed can be retried, and the retry actually merges", async () => {
    const { engine, bugs, forge, taskId } = await atMergeGate();
    forge.mergeResult = { ok: false, message: "Pull request is not mergeable" };
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    expect(bugs.get(taskId).stage).toBe("failed");

    forge.mergeResult = { ok: true, message: "merged (fake)" };   // whatever blocked it is now fixed
    await engine.retry(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(forge.merges).toEqual([{ number: 7, method: "squash" }, { number: 7, method: "squash" }]);
    expect(t.stage).toBe("done");
    expect(t.error).toBeNull();
  });

  // The other half: the same "skip failed too" fix must not let the *ungated* route start
  // merging just because it now has a "failed" of its own sitting where "merging" used to be
  // — its nearest non-"merging"/"failed" history entry is still "monitoring", never
  // "approved", however many retries pile on.
  it("the external path still cannot merge after a retry", async () => {
    const { engine, bugs, gitState } = await onMonitoringTask();
    forge.state = "OPEN";   // still not actually merged
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, state: "MERGED" }, event: { type: "pr-merged" } });
    await until(() => bugs.get("bt1").stage !== "merging", 2000);
    expect(bugs.get("bt1").stage).toBe("failed");

    await engine.retry("bt1");
    await until(() => bugs.get("bt1").stage !== "merging", 2000);
    expect(forge.merges).toEqual([]);                      // still never merges on the ungated path
    expect(bugs.get("bt1").stage).toBe("failed");
  });

  // Item 2, round 2: a PERSISTENT (not one-shot) `stopAgent` failure used to discard the
  // whole cleanup message. `doMerge`'s own guard around `stopAgent` folds the failure into
  // the message it returns — but `runServerStage` only patches that message onto the task
  // *after* `advance(stage-done)` resolves, and that `advance()` call runs `settleTerminal`,
  // which called the *same* persistently-failing `stopAgent` again, unguarded, rejecting the
  // whole `advance()` before the message was ever patched on. Guarding `settleTerminal`'s
  // call too (rather than, say, applying the message before the transition) keeps the fix at
  // the one place that generically owns "release resources for a task that just went
  // terminal" — every terminal transition benefits, not just this one.
  it("a persistent agent-freeing failure after a successful teardown still reaches done with the message", async () => {
    const { engine, bugs, store, taskId } = await atMergeGate();
    (store as any).getAgent = () => { throw new Error("agent already gone"); };
    await engine.approve(taskId);
    // `runServerStage` writes the cleanup message AFTER `advance({stage-done})` resolves
    // (the transition to "done" writes `error: null` first and would clobber an earlier
    // patch otherwise), so waiting only for `stage !== "merging"` can observe the task one
    // line too early, with `error` still `null`. Wait for the message too.
    await until(() => bugs.get(taskId).stage === "done" && bugs.get(taskId).error !== null, 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("done");
    expect(t.error).toMatch(/could not free the agent.*agent already gone/i);
  });

  it("a persistent agent-freeing failure alongside a worktree cleanup failure preserves both messages", async () => {
    const { engine, bugs, store, gitState, taskId } = await atMergeGate();
    gitState.removeError = "worktree cleanup incomplete: branch -D failed";
    (store as any).getAgent = () => { throw new Error("agent already gone"); };
    await engine.approve(taskId);
    // Same race as the sibling test above: wait for the cleanup message, not just the
    // stage transition, or `error` can still be `null` when we read it.
    await until(() => bugs.get(taskId).stage === "done" && bugs.get(taskId).error !== null, 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("done");
    expect(t.error).toMatch(/cleanup incomplete/i);
    expect(t.error).toMatch(/could not free the agent/i);
  });
});

describe("dismiss", () => {
  it("removes a finished task and its agent, and is refused while the task is live", async () => {
    const { engine, bugs, store, taskId } = await atMergeGate();
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const agentId = bugs.get(taskId).agentId;
    await engine.dismiss(taskId);
    expect(() => bugs.get(taskId)).toThrow();              // NotFound
    expect(() => store.getAgent(agentId)).toThrow();       // archived, not merely free

    const live = await onMonitoringTask();
    const liveId = live.bugs.list().at(-1)!.id;
    await expect(live.engine.dismiss(liveId)).rejects.toThrow(/still running|not finished/i);
  });
});

// Round 3: RECOVERABLE_STAGES previously excluded SERVER_STAGES ("pushing"/"merging")
// entirely, so a crash mid-stage left a task stranded there forever — retry() requires
// "failed", and no other event is legal from a server stage. That was the worst place in
// the whole workflow to have no exit: a crash mid-"merging" means nobody, not the user or
// the server, knows whether the merge actually landed. These tests seed a task in each
// server stage the way a crash would — via BugTaskStore directly, never through the
// engine's own dispatch, so nothing has actually run doMerge/doPush yet — then recover it
// and retry.
describe("recovering a task stranded mid server-stage by a crash", () => {
  it("recovers a task stuck mid-merging to failed with the restart reason, and retry reaches done without merging twice when the PR already reads MERGED", async () => {
    const { bugs, forge, taskId } = await atMergeGate();
    // Simulate the crash: drive exactly the transition `approve()` would (via the same
    // `nextStage`), but stop right there — no `doMerge` ever runs. This is what a process
    // death right after this stage-transition write, and before the engine's own detached
    // dispatch, leaves on disk.
    await bugs.apply(taskId, nextStage(bugs.get(taskId), { type: "approve" }));
    expect(bugs.get(taskId).stage).toBe("merging");

    await recoverStuckBugTasks(bugs);
    expect(bugs.get(taskId).stage).toBe("failed");
    expect(bugs.get(taskId).error).toMatch(/restart/i);

    // The merge actually landed before (or during) the crash — retry must confirm that
    // and tear down, never call forge.merge a second time.
    forge.state = "MERGED";
    const fresh = new BugFixEngine((engine as any).deps);
    fresh.attach();
    await fresh.retry(taskId);
    await until(() => bugs.get(taskId).stage !== "merging", 2000);
    const t = bugs.get(taskId);
    expect(forge.merges).toEqual([]);   // never called — the PR already read MERGED
    expect(t.stage).toBe("done");
  });

  it("recovers a task stuck mid-pushing to failed with the restart reason, and retry pushes again as a no-op", async () => {
    const { bugs, gitState, forge } = await atFeedbackDiffGate();
    const taskId = "bt1";
    await bugs.apply(taskId, nextStage(bugs.get(taskId), { type: "approve" }));
    expect(bugs.get(taskId).stage).toBe("pushing");

    await recoverStuckBugTasks(bugs);
    expect(bugs.get(taskId).stage).toBe("failed");
    expect(bugs.get(taskId).error).toMatch(/restart/i);

    // The branch may already be pushed — a retried push is a no-op that still succeeds:
    // the PR already reports the head the pin check expects.
    forge.prHead = gitState.head;
    const fresh = new BugFixEngine((engine as any).deps);
    fresh.attach();
    await fresh.retry(taskId);
    await until(() => bugs.get(taskId).stage !== "pushing", 2000);
    const t = bugs.get(taskId);
    expect(t.stage).toBe("monitoring");
    expect(t.error).toBeNull();
  });
});

describe("addressComments (a human-requested feedback round from the card)", () => {
  it("dispatches a feedback round with the given text, even past the cap", async () => {
    const { bugs, gitState } = await onMonitoringTask();
    await bugs.patch("bt1", { feedbackRounds: FEEDBACK_ROUND_CAP });
    void gitState; // silence unused-var in case of future edits
    const t = await engine.addressComments("bt1", "please fix the naming");
    expect(t.stage).toBe("review-feedback");
    expect(t.history.at(-1)).toMatchObject({ stage: "review-feedback", note: "please fix the naming" });
    // A round was actually spent, same as any other review-feedback dispatch — the cap is
    // bypassed for *whether to dispatch*, not for the accounting the cap itself reads.
    expect(t.feedbackRounds).toBe(FEEDBACK_ROUND_CAP + 1);
  });

  it("trims the given text", async () => {
    await onMonitoringTask();
    const t = await engine.addressComments("bt1", "  fix it please  ");
    expect(t.history.at(-1)?.note).toBe("fix it please");
  });

  it("falls back to the forge's recent review comments when no text is given", async () => {
    const { bugs } = await onMonitoringTask();
    const deps = (engine as any).deps;
    deps.forge = {
      ...deps.forge,
      listReviewEvents: async () => [
        { kind: "review" as const, author: "alice", isBot: false, state: "CHANGES_REQUESTED", body: "please rename this", at: "2026-09-26T10:00:00Z" },
      ],
    };
    const t = await engine.addressComments("bt1");
    expect(t.stage).toBe("review-feedback");
    expect(t.history.at(-1)?.note).toMatch(/alice.*please rename this/is);
    void bugs;
  });

  it("falls back to a short note, not a thrown error, when the forge can't be read", async () => {
    const { bugs } = await onMonitoringTask();
    const deps = (engine as any).deps;
    deps.forge = { ...deps.forge, listReviewEvents: async () => { throw new Error("gh: rate limited"); } };
    const t = await engine.addressComments("bt1");
    expect(t.stage).toBe("review-feedback");
    expect(t.history.at(-1)?.note).toMatch(/pull request/i);
    void bugs;
  });

  it("is refused outside monitoring, same as any other watcher-only finding", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await expect(engine.addressComments(t.id, "x")).rejects.toThrow(/only while monitoring|monitoring/i);
  });
});

describe("notifications: stage transitions the user might not be watching each emit a bugtask event", () => {
  // The assertion here is deliberately about the emitted "bugtask" event, not about
  // notification text: the UI is what renders notifications, and it already listens to this
  // stream (store.on("event", ...) -> the "bugtask" case in reducer.ts). What this protects is
  // that the stage change actually reaches the stream — a transition applied without an event
  // emitted is a notification that silently never fires.
  it("emits when a watcher finding starts a feedback round", async () => {
    const { engine, gitState, seen } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "review-changes-requested", comments: "fix" } });
    expect(seen.some(e => e.task.stage === "review-feedback")).toBe(true);
  });

  it("emits when a watcher finding opens the merge gate", async () => {
    const { engine, bugs, gitState, seen } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: { ...gitState.pr, state: "OPEN" }, event: { type: "review-approved" } });
    await until(() => bugs.get("bt1").stage === "approved");
    expect(seen.some(e => e.task.stage === "approved")).toBe(true);
  });

  it("emits when the merge gate's approve reaches done", async () => {
    const { engine, bugs, taskId, seen } = await atMergeGate();
    await engine.approve(taskId);
    await until(() => bugs.get(taskId).stage === "done", 2000);
    expect(seen.some(e => e.task.stage === "done")).toBe(true);
  });

  it("also emits for a pr-closed ending, which reaches done directly with no merge gate", async () => {
    const { engine, bugs, gitState, seen } = await onMonitoringTask();
    await engine.onPrFinding({ taskId: "bt1", pr: gitState.pr, event: { type: "pr-closed" } });
    expect(bugs.get("bt1").stage).toBe("done");
    expect(bugs.get("bt1").error).toMatch(/closed without merging/i);
    expect(bugs.get("bt1").outcome).toBe("closed");
    expect(seen.some(e => e.task.stage === "done")).toBe(true);
  });
});

/**
 * Lands a fresh task at the first-round diff gate — implementing verified, gate open, no
 * reason — with its own engine (rather than the outer `engine`/`bugs`/`fake`), so the
 * "creating the pull request" tests below can drive it with nothing but `engine.approve()`
 * and `until()`. Every agent stage this suite exercises (`analyzing`, `opening-pr`) is
 * auto-completed from *inside* the fake `queryFn` itself: as soon as `Runner.consume()`
 * actually starts pulling from the stream (which is always after the stage's own
 * transition has been persisted, so `task.stage` below is never stale), it writes whatever
 * artifact that stage's real agent would have written, then reports success. That keeps
 * "write the artifact, then let the stage finish" atomic, with no separate event to race
 * against — the risk a plain `store.on("event", ...)` listener reacting to the assignment's
 * *creation* would run into, since nothing guarantees `queryFn` has even been called by
 * then.
 */
async function atDiffGateFirstRound() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "eng-home-"));
  const repoDir = await mkdtemp(path.join(tmpdir(), "eng-repo-"));
  const s = new Store(homeDir, path.resolve("roles"));
  await s.init();
  await writeFile(path.join(homeDir, "roles", "bugfix.md"), `---\nname: bugfix\navatar: 🐞\nmodel: claude-opus-5\n---\nYou fix bugs.`);
  await s.reloadRoles();
  const b = new BugTaskStore(homeDir);
  await b.init();

  const gs: { commits: number; head?: string; pushes: Array<{ dir: string; branch: string; force: boolean }> } = { commits: 0, pushes: [] };
  const { git: g } = fakeGit(gs);
  g.push = async (dir: string, branch: string, o: { force?: boolean } = {}) => { gs.pushes.push({ dir, branch, force: !!o.force }); };

  const forgeMock = {
    name: "github",
    created: [] as Array<{ repoDir: string; ctx: unknown }>,
    createResult: null as null | { found: PrInfo } | { found: null } | { unavailable: string },
    authStatus: async () => ({ ok: true, message: "ok" }),
    createPr: async (repoDir: string, ctx: unknown) => {
      forgeMock.created.push({ repoDir, ctx });
      return forgeMock.createResult ?? {
        found: { number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: gs.head ?? null, lastSeenEventAt: "t" },
      };
    },
    findPr: async () => null,
    getPr: async () => ({ found: null }),
    listReviewEvents: async () => [],
    merge: async () => ({ ok: true, message: "merged (fake)" }),
  };

  const queryFn: QueryFn = () => (async function* () {
    const task = b.list().at(-1)!;
    if (task.stage === "analyzing") await b.writeArtifact(task.id, "plan.md", "# Plan");
    // Only default it in when nothing has written it yet — a test that pre-seeds
    // `pr-body.md` itself (e.g. to simulate the agent writing nothing) must not have that
    // override clobbered by this generic fake-agent fill-in.
    if (task.stage === "opening-pr" && (await b.readArtifact(task.id, "pr-body.md")) === null) {
      await b.writeArtifact(task.id, "pr-body.md", `PR body.\n\nFixes ${ISSUE.url}`);
    }
    yield success("done");
  })();

  const eng = new BugFixEngine({
    store: s, bugs: b,
    manager: new Manager(s, { queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
    git: g, integrations: new IntegrationsStore(homeDir),
    tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} },
    forge: forgeMock as any, presetsDir: path.resolve("presets"),
  });
  eng.attach();

  gs.head = "aaa";
  const t = await eng.intake({ issueRef: "PAY-42", repo: repoDir });
  await until(() => b.get(t.id).stage === "plan-review", 2000);
  await eng.approve(t.id);
  gs.commits = 1;
  await until(() => b.get(t.id).stage === "diff-review", 2000);

  return { engine: eng, bugs: b, gitState: gs, forge: forgeMock };
}

describe("creating the pull request", () => {
  it("pushes the approved commit, creates the PR, and rests in monitoring", async () => {
    const h = await atDiffGateFirstRound();          // helper: implementing verified, gate open, no reason
    h.gitState.head = "aaa";                          // equals approvedHead
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "monitoring", 2000);
    const t = h.bugs.get("bt1");
    expect(h.gitState.pushes).toEqual([{ dir: t.worktree, branch: t.branch, force: false }]);
    expect(h.forge.created).toHaveLength(1);
    expect(t.pr).toMatchObject({ state: "OPEN" });
    expect(t.error).toBeNull();
  });

  it("refuses to create when the branch moved after approval", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "zzz";                          // moved since the gate opened
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.gitState.pushes).toEqual([]);
    expect(h.forge.created).toEqual([]);
    expect(h.bugs.get("bt1").error).toMatch(/moved since the diff was approved/i);
  });

  it("fails the stage with the forge's message when creation is unavailable", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    h.forge.createResult = { unavailable: "bitbucket: 503 service unavailable" };
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.bugs.get("bt1").error).toMatch(/503 service unavailable/);
  });

  it("is idempotent on retry: a PR that already exists is adopted, not duplicated", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    h.forge.createResult = { unavailable: "network blip" };
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    h.forge.createResult = null;                      // the adapter now adopts the existing PR
    await h.engine.retry("bt1");
    await until(() => h.bugs.get("bt1").stage === "monitoring", 2000);
    expect(h.bugs.get("bt1").pr).toMatchObject({ state: "OPEN" });
  });

  it("verifies opening-pr by the PR body alone — no forge call", async () => {
    const h = await atDiffGateFirstRound();
    h.gitState.head = "aaa";
    await h.bugs.writeArtifact("bt1", "pr-body.md", "");     // agent wrote nothing
    await h.engine.approve("bt1");
    await until(() => h.bugs.get("bt1").stage === "failed", 2000);
    expect(h.bugs.get("bt1").error).toMatch(/pr-body\.md/i);
    expect(h.forge.created).toEqual([]);
  });
});

/** The assumptions path this dispatch's prompt named — the test plays the agent and writes there. */
const assumptionsPathIn = (prompt: string) => /(\S+assumptions-[a-f0-9]+\.json)/.exec(prompt)![1];

describe("assumptions", () => {
  it("records what the analyze stage reported, tagged with its stage", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), JSON.stringify([{ kind: "question", text: "Up or down?" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions).toMatchObject([{ stage: "analyzing", round: 0, kind: "question", text: "Up or down?" }]);
  });

  it("records them even when the stage fails", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), JSON.stringify([{ kind: "assumption", text: "No plan needed" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");   // no plan.md
    expect(bugs.get(t.id).assumptions.map(a => a.text)).toEqual(["No plan needed"]);
  });

  it("gives every dispatch its own file, so a later round never re-reads an earlier one", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    const first = assumptionsPathIn(fake.calls.at(-1)!.prompt);
    await writeFile(first, JSON.stringify([{ kind: "assumption", text: "first" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await engine.requestChanges(t.id, "again");
    expect(assumptionsPathIn(fake.calls.at(-1)!.prompt)).not.toBe(first);
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions.map(a => a.text)).toEqual(["first"]);
  });

  it("a malformed file sets the problem and the stage still advances; a clean read clears it", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "not json");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toMatch(/not valid JSON/);
    await engine.requestChanges(t.id, "again");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "[]");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toBeNull();
  });

  it("no file leaves the task's assumptions and problem untouched", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptions).toEqual([]);
    expect(bugs.get(t.id).assumptionsProblem).toBeNull();
  });
  it("records which dispatch it read last, even when that run reported nothing or wrote no file", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), JSON.stringify([{ kind: "question", text: "Up or down?" }]));
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    const first = bugs.get(t.id).assumptionsToken;
    expect(first).toMatch(/^[a-f0-9]+$/);
    await engine.requestChanges(t.id, "round down");
    const second = /assumptions-([a-f0-9]+)\.json/.exec(fake.calls.at(-1)!.prompt)![1];
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "[]");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsToken).toBe(second);
    await engine.requestChanges(t.id, "again");
    const third = /assumptions-([a-f0-9]+)\.json/.exec(fake.calls.at(-1)!.prompt)![1];
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");   // no file this time
    expect(bugs.get(t.id).assumptionsToken).toBe(third);
    expect(bugs.get(t.id).assumptions.map(a => a.text)).toEqual(["Up or down?"]);
  });
  it("a later run that wrote no file clears an earlier run's malformed-file warning", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await writeFile(assumptionsPathIn(fake.calls.at(-1)!.prompt), "not json");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toMatch(/not valid JSON/);
    await engine.requestChanges(t.id, "again");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    expect(bugs.get(t.id).assumptionsProblem).toBeNull();
  });
});

// The reported case: PR creation failed, the user had the agent open the PR from a terminal,
// and AgentGrid went on showing "failed".
describe("a pull request opened outside AgentGrid", () => {
  const APPROVED = "a".repeat(40);
  async function failedAtCreatingPr() {
    const home2 = await mkdtemp(path.join(tmpdir(), "eng-ext-"));
    const store2 = new Store(home2, path.resolve("roles")); await store2.init();
    await writeFile(path.join(home2, "roles", "bugfix.md"), `---\nname: bugfix\navatar: 🐞\nmodel: claude-opus-5\n---\nYou fix bugs.`);
    await store2.reloadRoles();
    const bugs2 = new BugTaskStore(home2); await bugs2.init();
    const fake2 = makeFakeQuery();
    const git2: { commits: number; head?: string } = { commits: 0 };
    const said: Array<[string, string]> = [];
    const ext = { pr: null as PrInfo | null };
    const e2 = new BugFixEngine({
      store: store2, bugs: bugs2,
      manager: new Manager(store2, { queryFn: fake2.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) }),
      git: fakeGit(git2).git, integrations: new IntegrationsStore(home2),
      tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async (k, t) => { said.push([k, t]); } },
      forge: { ...forge, createPr: async () => ({ unavailable: "could not determine the Bitbucket repository" }), findPr: async () => ext.pr },
      presetsDir: path.resolve("presets"),
    });
    e2.attach();
    const finish = async () => { fake2.emit(success("done")); fake2.end(); };
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs2.writeArtifact(t.id, "plan.md", "# Plan");
    await finish(); await until(() => bugs2.get(t.id).stage === "plan-review");
    await e2.approve(t.id); git2.commits = 1;
    await finish(); await until(() => bugs2.get(t.id).stage === "diff-review");
    await e2.approve(t.id);
    await bugs2.writeArtifact(t.id, "pr-body.md", "PR body");
    await finish(); await until(() => bugs2.get(t.id).stage === "failed");
    return { e2, bugs: bugs2, id: t.id, git2, said, ext };
  }
  const extPr = (over: Partial<PrInfo> = {}): PrInfo => ({ number: 7, url: "https://bb/pr/7", state: "OPEN", reviewDecision: null, checks: null, mergeable: "MERGEABLE", headSha: APPROVED.slice(0, 12), lastSeenEventAt: "t", ...over });

  it("at the approved commit, is adopted and watched, and the ticket hears about it", async () => {
    const { e2, bugs, id, said } = await failedAtCreatingPr();
    await e2.onPrFinding({ taskId: id, pr: extPr(), event: null, external: true, checkedAt: new Date().toISOString() });
    const t = bugs.get(id);
    expect(t.stage).toBe("monitoring");
    expect(t.pr).toMatchObject({ number: 7, url: "https://bb/pr/7" });
    expect(t.error).toBeNull();
    expect(t.history.at(-1)!.note).toMatch(/#7.*outside AgentGrid/);
    expect(said).toContainEqual(["PAY-42", expect.stringContaining("https://bb/pr/7")]);
  });

  it("with commits nobody reviewed here, opens the diff gate on what is actually in the PR", async () => {
    const { e2, bugs, id, git2 } = await failedAtCreatingPr();
    git2.head = "b".repeat(40);                                   // the terminal session committed more
    await e2.onPrFinding({ taskId: id, pr: extPr({ headSha: "b".repeat(40) }), event: null, external: true, checkedAt: new Date().toISOString() });
    const t = bugs.get(id);
    expect(t.stage).toBe("diff-review");
    expect(t.gate).toMatchObject({ kind: "diff", reason: "external" });
    expect(t.approvedHead).toBe("b".repeat(40));                 // what the human is about to review
    expect(t.pr).toMatchObject({ number: 7 });
    expect(await bugs.readArtifact(id, "diff.patch")).toContain("diff --git");
  });

  it("whose commit isn't in the worktree, stays failed and says how to bring it in", async () => {
    const { e2, bugs, id } = await failedAtCreatingPr();
    await e2.onPrFinding({ taskId: id, pr: extPr({ headSha: "c".repeat(40) }), event: null, external: true, checkedAt: new Date().toISOString() });
    const t = bugs.get(id);
    expect(t.stage).toBe("failed");
    expect(t.error).toMatch(/#7/);
    expect(t.error).toMatch(/worktree/);
    expect(t.pr).toMatchObject({ number: 7 });
  });

  it("that was closed without merging, stays failed and says so", async () => {
    const { e2, bugs, id } = await failedAtCreatingPr();
    await e2.onPrFinding({ taskId: id, pr: extPr({ state: "CLOSED" }), event: null, external: true, checkedAt: new Date().toISOString() });
    expect(bugs.get(id).stage).toBe("failed");
    expect(bugs.get(id).error).toMatch(/#7.*closed without merging/);
  });

  it("that was already merged, is adopted so the merge is recorded", async () => {
    const { e2, bugs, id } = await failedAtCreatingPr();
    await e2.onPrFinding({ taskId: id, pr: extPr({ state: "MERGED", headSha: "d".repeat(40) }), event: null, external: true, checkedAt: new Date().toISOString() });
    expect(bugs.get(id).stage).toBe("monitoring");                // the watcher's merged path finishes it
  });

  it("Retry adopts it instead of failing on the moved branch", async () => {
    const { e2, bugs, id, git2, ext } = await failedAtCreatingPr();
    git2.head = "b".repeat(40);
    ext.pr = extPr({ headSha: "b".repeat(40) });
    await e2.retry(id);
    expect(bugs.get(id).stage).toBe("diff-review");
    expect(bugs.get(id).gate).toMatchObject({ reason: "external" });
  });
});
