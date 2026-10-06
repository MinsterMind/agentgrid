import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { parsePrRef, AgentPrWatcher, rereviewPrompt } from "../src/agentpr.js";
import type { ForgeAdapter, PrLookup } from "../src/bugfix/forge/types.js";
import type { PrInfo } from "../src/bugfix/types.js";

describe("parsePrRef", () => {
  it("reads a PR from a GitHub or Bitbucket link, 'PR 42', 'pull request #42' or '#42'", () => {
    expect(parsePrRef("Review https://github.com/acme/api/pull/118 please")).toBe(118);
    expect(parsePrRef("look at https://bitbucket.org/team/repo/pull-requests/7/diff")).toBe(7);
    expect(parsePrRef("Review PR 42")).toBe(42);
    expect(parsePrRef("review pull request #9 for races")).toBe(9);
    expect(parsePrRef("review #31")).toBe(31);
  });
  it("finds nothing in a task that names no PR", () => {
    expect(parsePrRef("Add idempotency keys to the webhook handler")).toBeNull();
    expect(parsePrRef("fix the 2 failing tests in api/")).toBeNull();
  });
});

const pr = (x: Partial<PrInfo> = {}): PrInfo => ({ number: 42, url: "https://github.com/a/b/pull/42", state: "OPEN", reviewDecision: "CHANGES_REQUESTED", checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "aaaaaaa1", lastSeenEventAt: "", ...x });
function stubForge(lookup: () => PrLookup) {
  const calls: Array<[string, number]> = [];
  const forge = { name: "stub", getPr: async (repo: string, n: number) => { calls.push([repo, n]); return lookup(); } } as unknown as ForgeAdapter;
  return { forge, calls };
}

describe("AgentPrWatcher", () => {
  let store: Store;
  beforeEach(async () => { store = new Store(await mkdtemp(path.join(tmpdir(), "apr-")), path.resolve("roles")); await store.init(); });
  const running = async (prompt: string) => {
    const ag = await store.createAgent({ role: "reviewer", repo: "/x/repo" });
    const a = await store.createAssignment({ agentId: ag.id, prompt });
    await store.updateAgent(ag.id, { state: "working", currentAssignmentId: a.id });
    return { ag, a };
  };

  it("puts the PR's status on the agent's task, and remembers the commit the review finished on", async () => {
    let cur = pr();
    const { forge, calls } = stubForge(() => ({ found: cur }));
    const w = new AgentPrWatcher({ store, forge: () => forge });
    const { a } = await running("Review PR 42");
    await w.tick();
    expect(calls).toEqual([["/x/repo", 42]]);
    expect(store.getAssignment(a.id).pr).toMatchObject({ number: 42, url: "https://github.com/a/b/pull/42", state: "OPEN", reviewDecision: "CHANGES_REQUESTED", checks: "SUCCESS", headSha: "aaaaaaa1" });
    expect(store.getAssignment(a.id).pr?.reviewedSha).toBeUndefined();     // still reviewing
    await store.updateAssignment(a.id, { state: "done", outcome: "2 issues" });
    await w.tick();
    expect(store.getAssignment(a.id).pr?.reviewedSha).toBe("aaaaaaa1");
    cur = pr({ headSha: "bbbbbbb2" });                                       // the author pushed a fix
    await w.tick();
    expect(store.getAssignment(a.id).pr).toMatchObject({ headSha: "bbbbbbb2", reviewedSha: "aaaaaaa1" });
  });

  it("stops asking once the PR is merged or closed, and leaves tasks without a PR alone", async () => {
    const { forge, calls } = stubForge(() => ({ found: pr({ state: "MERGED" }) }));
    const w = new AgentPrWatcher({ store, forge: () => forge });
    await running("Review PR 42"); await running("refactor the parser");
    await w.tick(); await w.tick();
    expect(calls).toHaveLength(1);
  });

  it("says why there is no status instead of showing nothing", async () => {
    const { a } = await running("Review PR 42");
    await new AgentPrWatcher({ store, forge: () => null }).tick();
    expect(store.getAssignment(a.id).pr).toEqual({ number: 42, note: "Set up GitHub or Bitbucket in Settings to see this PR's status" });
    const { forge } = stubForge(() => ({ unavailable: "gh: not logged in" }));
    await new AgentPrWatcher({ store, forge: () => forge }).tick();
    expect(store.getAssignment(a.id).pr).toEqual({ number: 42, note: "Couldn't read the PR: gh: not logged in" });
  });
});

describe("rereviewPrompt", () => {
  it("points the reviewer at what changed and at its own earlier findings", () => {
    const p = rereviewPrompt({ number: 42, url: "https://github.com/a/b/pull/42", headSha: "bbbbbbb2c", reviewedSha: "aaaaaaa1c" });
    expect(p).toContain("Re-review PR #42 (https://github.com/a/b/pull/42)");
    expect(p).toContain("aaaaaaa..bbbbbbb");
    expect(p).toMatch(/earlier findings/);
  });
});
