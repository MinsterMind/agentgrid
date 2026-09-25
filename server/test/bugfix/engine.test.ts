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
import type { TrackerIssue } from "../../src/bugfix/types.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };

/** Fake git: records calls, pretends a worktree and commits exist. */
function fakeGit(state: { commits: number }) {
  const calls: string[] = [];
  const g = new GitOps(async () => "");
  g.defaultBranch = async () => "main";
  g.hasRemote = async () => "git@github.com:acme/pay.git";
  g.createWorktree = async (repo, branch) => { calls.push(`create ${branch}`); const d = path.join(repo, ".worktrees", branch.replace("/", "-")); await mkdir(d, { recursive: true }); return d; };
  g.removeWorktree = async () => { calls.push("remove"); };
  g.currentBranch = async () => "bugfix/PAY-42";
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
let engine: BugFixEngine; let comments: Array<[string, string]>; let gitState: { commits: number };

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

// Note: only emit() is needed — the runner's consume() loop returns as soon as it sees
// a "result" message, so it never drains a subsequent end() marker off the fake's shared
// queue. A stray end() here would sit in that queue and be swallowed as the *first* item
// of the next stage's stream (since queryFn's async generator is fresh per assign() but
// shares the queue), making that stream look like it ended with no result at all.
const finishStage = async () => { fake.emit(success("done")); };

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
    const e2 = new BugFixEngine({ ...(engine as any).deps, forge: { ...forge, findPr: async () => null } });
    e2.attach();
    const t = await e2.intake({ issueRef: "PAY-42", repo });
    await bugs.writeArtifact(t.id, "plan.md", "# Plan");
    await finishStage(); await until(() => bugs.get(t.id).stage === "plan-review");
    await e2.approve(t.id); gitState.commits = 1;
    await finishStage(); await until(() => bugs.get(t.id).stage === "diff-review");
    await e2.approve(t.id);
    await finishStage(); await until(() => bugs.get(t.id).stage === "failed");
    expect(bugs.get(t.id).error).toMatch(/no pull request/i);
  });
});

describe("cancel and guards", () => {
  it("cancel stops the task and leaves the worktree alone", async () => {
    const t = await engine.intake({ issueRef: "PAY-42", repo });
    await engine.cancel(t.id);
    expect(bugs.get(t.id).stage).toBe("cancelled");
    expect(store.getAgent(t.agentId).state).not.toBe("working");
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
  });
});
