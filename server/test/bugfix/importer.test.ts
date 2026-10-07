import { describe, it, expect, vi } from "vitest";
import { Importer, matchesKey } from "../../src/bugfix/importer.js";

const issue = (key: string) => ({ key, title: key, url: "", status: "", priority: "", description: "", acceptanceCriteria: [] });
const pr = (n: number, headBranch: string, title = "x") => ({ number: n, url: `u${n}`, state: "OPEN" as const, reviewDecision: null, checks: null, mergeable: null, headSha: "abc1234", lastSeenEventAt: "t", headBranch, baseBranch: "develop", title });
function setup(over: { prs?: any[]; branches?: string[]; merged?: any; active?: string | null; listing?: "unavailable" } = {}) {
  const engine = {
    importTask: vi.fn(async (i: any) => ({ id: `bt-${i.issue.key}`, stage: i.found.kind === "pr" ? "monitoring" : i.found.kind === "branch" ? "diff-review" : "done" })),
    intake: vi.fn(async (i: any) => ({ id: `bt-${i.issueRef}`, stage: "analyzing" })),
  };
  const git = { fetch: vi.fn(async () => {}), remoteBranches: vi.fn(async () => over.branches ?? ["develop", "main"]), integrationBranch: vi.fn(async () => "develop") };
  const forge = { listOpenPrs: vi.fn(async () => over.listing === "unavailable" ? { unavailable: "gh broke" } : { prs: over.prs ?? [] }), findMergedPr: vi.fn(async () => over.merged ?? null) };
  const cache = { issues: vi.fn(async (keys: string[]) => ({ issues: keys.map(issue), missing: [], errors: {} })) };
  const imp = new Importer({ engine: engine as any, git: git as any, forge: forge as any, tracker: {} as any, cache: cache as any, activeTaskFor: () => over.active ?? null });
  return { imp, engine, git, forge, cache };
}
const done = async (imp: Importer, id: string) => { for (let i = 0; i < 200 && !imp.get(id)!.finished; i++) await new Promise(r => setTimeout(r, 5)); return imp.get(id)!; };

describe("Importer (spec 2026-10-09 §3)", () => {
  it("whole-word key matching", () => {
    expect(matchesKey("feature/PAY-41-fix", "PAY-41")).toBe(true);
    expect(matchesKey("feature/PAY-410", "PAY-41")).toBe(false);
    expect(matchesKey("pay-41: Fix it", "PAY-41")).toBe(true);
    expect(matchesKey("XPAY-41", "PAY-41")).toBe(false);
  });
  it("an open PR by branch lands at monitoring; by title too", async () => {
    const { imp, engine } = setup({ prs: [pr(3, "feature/PAY-1-x"), pr(4, "hotfix", "PAY-2 tidy")] });
    const s = await done(imp, imp.start(["PAY-1", "PAY-2"], "/r"));
    expect(s.imported.map(i => [i.key, i.stage])).toEqual([["PAY-1", "monitoring"], ["PAY-2", "monitoring"]]);
    expect(engine.importTask.mock.calls[0][0].found).toMatchObject({ kind: "pr", pr: { number: 3 } });
  });
  it("several matching PRs need a choice; choosing imports that one", async () => {
    const { imp, engine } = setup({ prs: [pr(3, "a/PAY-1"), pr(5, "b/PAY-1")] });
    const id = imp.start(["PAY-1"], "/r");
    const s = await done(imp, id);
    expect(s.choose[0]).toMatchObject({ key: "PAY-1", candidates: [{ number: 3 }, { number: 5 }] });
    const after = await imp.choose(id, "PAY-1", 5);
    expect(after.choose).toEqual([]);
    expect(after.imported[0]).toMatchObject({ key: "PAY-1" });
    expect(engine.importTask.mock.calls[0][0].found.pr.number).toBe(5);
    await expect(imp.choose(id, "PAY-1", 5)).rejects.toThrow(/nothing to choose/);
  });
  it("a branch with no PR lands at diff review; nothing found starts a normal fix", async () => {
    const { imp, engine } = setup({ branches: ["develop", "bugfix/PAY-1"] });
    const s = await done(imp, imp.start(["PAY-1", "PAY-2"], "/r"));
    expect(engine.importTask.mock.calls[0][0].found).toEqual({ kind: "branch", branch: "bugfix/PAY-1" });
    expect(engine.intake).toHaveBeenCalledWith(expect.objectContaining({ issueRef: "PAY-2", fetched: true }));
    expect(s.imported.map(i => i.key).sort()).toEqual(["PAY-1", "PAY-2"]);
  });
  it("merged → done", async () => {
    const { imp, engine } = setup({ merged: { ...pr(9, "bugfix/PAY-1"), state: "MERGED" } });
    await done(imp, imp.start(["PAY-1"], "/r"));
    expect(engine.importTask.mock.calls[0][0].found.kind).toBe("merged");
  });
  it("already in AgentGrid is skipped with its id; one fetch and one listing per repo; keys deduped", async () => {
    const { imp, git, forge } = setup({ active: "bt7" });
    const s = await done(imp, imp.start(["PAY-1", "PAY-2", "pay-1"], "/r"));
    expect(s.total).toBe(2);
    expect(s.skipped).toHaveLength(2);
    expect(s.skipped[0].message).toMatch(/already in AgentGrid \(bt7\)/);
    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(forge.listOpenPrs).toHaveBeenCalledTimes(1);
    expect(forge.listOpenPrs).toHaveBeenCalledWith("/r", { all: true });
  });
  it("a failure for one key doesn't stop the others", async () => {
    const { imp, engine } = setup({ prs: [pr(3, "a/PAY-1")] });
    engine.importTask.mockRejectedValueOnce(new Error("leftover worktree"));
    const s = await done(imp, imp.start(["PAY-1", "PAY-2"], "/r"));
    expect(s.failed).toEqual([{ key: "PAY-1", message: "leftover worktree" }]);
    expect(s.imported.map(i => i.key)).toEqual(["PAY-2"]);
  });
  it("a failed fetch fails every key with the reason", async () => {
    const { imp, git } = setup();
    git.fetch.mockRejectedValueOnce(new Error("no network"));
    const s = await done(imp, imp.start(["PAY-1", "PAY-2"], "/r"));
    expect(s.failed.map(f => f.message)).toEqual(["could not fetch from origin: no network", "could not fetch from origin: no network"]);
  });
  it("may already be fixed is skipped, with intake's message", async () => {
    const { imp, engine } = setup();
    engine.intake.mockRejectedValueOnce(Object.assign(new Error("PAY-1 may already be fixed"), { code: "already-on-base" }));
    const s = await done(imp, imp.start(["PAY-1"], "/r"));
    expect(s.skipped).toEqual([{ key: "PAY-1", message: "PAY-1 may already be fixed" }]);
  });
});
