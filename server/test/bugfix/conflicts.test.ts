import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConflictWatcher } from "../../src/bugfix/conflicts.js";
import { BugTaskStore } from "../../src/bugfix/store.js";
import { GitOps } from "../../src/bugfix/git.js";
import { sh, gitflowClone } from "../helpers/gitRepos.js";
import type { BugEvent, BugStage, PrInfo } from "../../src/bugfix/types.js";

const PR: PrInfo = { number: 1, url: "u", state: "OPEN", reviewDecision: null, checks: null, mergeable: null, headSha: null, lastSeenEventAt: "t" };
let seed: string; let origin: string; let clone: string; let bugs: BugTaskStore; let git: GitOps;
let findings: Array<{ taskId: string; event: BugEvent }>; let problems: Array<[string, string | null]>; let fetches: number;

/** Two bug branches off develop that both rewrite src.txt; tasks for both rest on open PRs. */
beforeEach(async () => {
  ({ seed, origin, clone } = await gitflowClone());
  for (const [b, text] of [["bugfix/A", "a\n"], ["bugfix/B", "b\n"]] as const) {
    await sh(seed, ["checkout", "-q", "-b", b, "develop"]); await writeFile(path.join(seed, "src.txt"), text);
    await sh(seed, ["commit", "-qam", b]); await sh(seed, ["push", "-q", origin, b]);
  }
  await sh(seed, ["checkout", "-q", "develop"]);
  bugs = new BugTaskStore(await mkdtemp(path.join(tmpdir(), "cw-"))); await bugs.init();
  for (const key of ["A", "B"]) {
    const t = await bugs.create({ issue: { key, title: key, url: "u", status: "Open", priority: "High", description: "", acceptanceCriteria: [] }, trackerProject: "X",
      sourceRepo: clone, worktree: clone, branch: `bugfix/${key}`, baseBranch: "develop", baseRef: "origin/develop", ticketCommits: [], agentId: `a${key}`, mergePolicy: "ask", mergeMethod: "squash" });
    await bugs.patch(t.id, { stage: "monitoring", pr: PR });
  }
  git = new GitOps();
  fetches = 0; const realFetch = git.fetch.bind(git); git.fetch = async r => { fetches++; return realFetch(r); };
  findings = []; problems = [];
});
const watcher = () => new ConflictWatcher({ bugs, git, onFinding: async f => { findings.push(f); }, onProblem: async (id, m) => { problems.push([id, m]); } });
const mergeIntoDevelop = async (b: string) => { await sh(seed, ["merge", "-q", "--no-ff", "-m", `merge ${b}`, b]); await sh(seed, ["push", "-q", origin, "develop"]); };
const idOf = (key: string) => bugs.list().find(t => t.issue.key === key)!.id;

describe("ConflictWatcher", () => {
  it("merging one branch makes the other conflict — found once, with its files", async () => {
    const w = watcher();
    await w.tick();                                    // first pass: everything clean
    expect(findings).toEqual([]);
    await mergeIntoDevelop("bugfix/A");
    await w.tick();
    expect(findings).toEqual([{ taskId: idOf("B"), event: { type: "conflicting", files: ["src.txt"], base: "develop" } }]);
  });

  it("is quiet when the base hasn't moved: no fetch, no findings", async () => {
    const w = watcher();
    await w.tick(); const after = fetches;
    await w.tick();
    expect(fetches).toBe(after); expect(findings).toEqual([]);
  });

  it("a nudge re-checks without a base move", async () => {
    const w = watcher();
    await w.tick(); const after = fetches;
    w.nudge(clone);
    await w.tick();
    expect(fetches).toBe(after + 1);
  });

  it("a task already at the conflict gate is not reported again; one that merges cleanly again is cleared", async () => {
    const w = watcher();
    await mergeIntoDevelop("bugfix/A");
    await bugs.patch(idOf("B"), { stage: "conflict" as BugStage });
    await w.tick();
    expect(findings).toEqual([]);
    // someone rebases B by hand so it merges cleanly
    await sh(seed, ["checkout", "-q", "bugfix/B"]); await sh(seed, ["reset", "-q", "--hard", "develop"]);
    await writeFile(path.join(seed, "other.txt"), "b\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "B redone"]);
    await sh(seed, ["push", "-q", "-f", origin, "bugfix/B"]); await sh(seed, ["checkout", "-q", "develop"]);
    w.nudge(clone);
    await w.tick();
    expect(findings).toEqual([{ taskId: idOf("B"), event: { type: "conflict-cleared" } }]);
  });

  it("an unknown result changes nothing; a branch never pushed is skipped", async () => {
    await bugs.patch(idOf("A"), { branch: "bugfix/never-pushed" });
    await mergeIntoDevelop("bugfix/B");
    const w = watcher();
    await w.tick();
    expect(findings).toEqual([]);
  });

  // Review Focus 2
  it("a base that moves again after a rebase is seen on the next pass", async () => {
    const w = watcher();
    await w.tick();
    await mergeIntoDevelop("bugfix/A");
    await w.tick();
    expect(findings.map(f => f.event.type)).toEqual(["conflicting"]);
    // B is rebased (its conflict resolved) and back to monitoring…
    await sh(seed, ["checkout", "-q", "bugfix/B"]); await sh(seed, ["reset", "-q", "--hard", "develop"]);
    await writeFile(path.join(seed, "src.txt"), "a\nb\n"); await sh(seed, ["commit", "-qam", "B rebased"]);
    await sh(seed, ["push", "-q", "-f", origin, "bugfix/B"]); await sh(seed, ["checkout", "-q", "develop"]);
    w.nudge(clone); await w.tick();
    expect(findings).toHaveLength(1);
    // …then develop moves again, touching the same line
    await writeFile(path.join(seed, "src.txt"), "c\n"); await sh(seed, ["commit", "-qam", "develop moves"]); await sh(seed, ["push", "-q", origin, "develop"]);
    await w.tick();
    expect(findings.at(-1)).toEqual({ taskId: idOf("B"), event: { type: "conflicting", files: ["src.txt"], base: "develop" } });
  });

  it("a fetch failure reports a problem and keeps the conflict; the next good pass clears the problem", async () => {
    await bugs.patch(idOf("B"), { stage: "conflict" as BugStage });
    const w = watcher();
    const realFetch = git.fetch.bind(git);
    git.fetch = async () => { throw new Error("could not resolve host"); };
    w.nudge(clone);
    await w.tick();
    expect(findings).toEqual([]);
    expect(problems.find(([id]) => id === idOf("B"))?.[1]).toMatch(/Couldn't check for conflicts: could not resolve host/);
    git.fetch = realFetch; w.nudge(clone);
    await w.tick();
    expect(problems.filter(([id]) => id === idOf("B")).at(-1)?.[1]).toBeNull();
  });

  // Final review #5: merge-tree --write-tree needs git 2.38+; older git used to fail silently.
  it("on git older than 2.38 it says so on every card and checks nothing", async () => {
    (git as any).run = async (_c: string, args: string[]) => { if (args[0] === "--version") return "git version 2.34.1\n"; throw new Error("unexpected"); };
    await mergeIntoDevelop("bugfix/A");
    await watcher().tick();
    expect(findings).toEqual([]);
    expect(problems.map(([, m]) => m)).toEqual([expect.stringMatching(/need git 2\.38 or newer.*2\.34\.1/), expect.stringMatching(/2\.38/)]);
  });
  it("reads the git version", async () => {
    expect(await new GitOps(async () => "git version 2.50.1 (Apple Git-155)\n").gitVersion()).toEqual([2, 50, 1]);
    expect(await new GitOps(async () => { throw new Error("no git"); }).gitVersion()).toBeNull();
  });
});
