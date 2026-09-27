import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../../src/store/store.js";
import { Manager } from "../../src/runner/manager.js";
import { createApp } from "../../src/api/app.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { BugFixEngine } from "../../src/bugfix/engine.js";
import { GitOps } from "../../src/bugfix/git.js";
import { IntegrationsStore } from "../../src/bugfix/integrations.js";
import { makeFakeQuery, success } from "../helpers/fakeQuery.js";
import { until } from "../helpers/until.js";
import type { TrackerIssue } from "../../src/bugfix/types.js";

const ISSUE: TrackerIssue = { key: "PAY-42", title: "Boom", url: "https://x/PAY-42", status: "Open", priority: "High", description: "d", acceptanceCriteria: [] };

/** Same fake git the engine's own tests use: pretends a worktree and commits exist. */
function fakeGit() {
  const g = new GitOps(async () => "");
  g.defaultBranch = async () => "main";
  g.hasRemote = async () => "git@github.com:acme/pay.git";
  g.createWorktree = async (repo, branch) => { const d = path.join(repo, ".worktrees", branch.replace("/", "-")); await mkdir(d, { recursive: true }); return d; };
  g.removeWorktree = async () => {};
  g.currentBranch = async () => "bugfix/PAY-42";
  g.commitsAhead = async () => 1;
  g.worktreeRegistered = async () => false;
  g.branchExists = async () => false;
  // Without this, revParse falls through to the base `run` fake (`async () => ""`), so
  // `approvedHead` gets set to a falsy "" and the opening-pr pin guard trips on every
  // run — silently making that stage unreachable through this harness.
  g.revParse = async () => "abc1234abc1234abc1234abc1234abc1234abc1";
  g.diff = async () => ({ patch: "diff --git a/a b/a\n+x\n", files: [{ path: "a", additions: 1, deletions: 0 }], additions: 1, deletions: 0 });
  return g;
}

const forge = {
  name: "github",
  authStatus: async () => ({ ok: true, message: "ok" }),
  createPrCommand: () => "gh pr create --base 'main' --head 'bugfix/PAY-42' --title 't' --body-file '/b'",
  findPr: async () => ({ number: 7, url: "https://gh/pr/7", state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: "MEEGEABLE", headSha: "abc1234", lastSeenEventAt: "t" }),
  getPr: async () => ({ found: null }),
  listReviewEvents: async () => [],
  merge: async () => ({ ok: true, message: "merged (fake)" }),
};

/**
 * Builds a full HTTP app over a *real* BugFixEngine (only the network-facing edges —
 * git, forge, tracker, the agent query — are faked), for tests that need the actual
 * stage machine and its error shapes behind the routes, not the route-level fake engine
 * `api.test.ts` otherwise uses.
 */
export async function createBugFixTestApp() {
  const home = await mkdtemp(path.join(tmpdir(), "api-real-eng-"));
  const store = new Store(home, path.resolve("roles"));
  await store.init();
  await mkdir(path.join(home, "roles"), { recursive: true });
  await writeFile(path.join(home, "roles", "bugfix.md"), `---\nname: bugfix\navatar: \u{1F41E}\nmodel: claude-opus-5\n---\nYou fix bugs.`);
  await store.reloadRoles();
  const bugs = new BugTaskStore(home);
  await bugs.init();
  const fake = makeFakeQuery();
  const manager = new Manager(store, { queryFn: fake.queryFn, buildOptions: (_r, a, e) => ({ cwd: a.repo, abortController: e.abortController, canUseTool: e.canUseTool } as Options) });
  const engine = new BugFixEngine({
    store, bugs, manager,
    git: fakeGit(), integrations: new IntegrationsStore(home),
    tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} },
    forge, presetsDir: path.resolve("presets"),
  });
  engine.attach();

  const app = createApp({
    store, manager,
    bugs: { engine, store: bugs, integrations: new IntegrationsStore(home), tracker: { listMyIssues: async () => [], fetchIssue: async () => ISSUE, comment: async () => {} } },
  });

  return {
    app, bugs, engine, until,
    finishStage: async () => { fake.emit(success("done")); fake.end(); },
  };
}
