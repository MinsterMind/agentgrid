import { describe, it, expect } from "vitest";
import { makeForge, type Runner } from "../../src/bugfix/forge/index.js";

/** One recorded `gh pr list` payload — the shape the adapter must survive. */
const GH_PR_LIST = JSON.stringify([{
  number: 482, url: "https://github.com/acme/pay/pull/482", state: "OPEN", isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", updatedAt: "2026-09-25T10:00:00Z",
  statusCheckRollup: [{ state: "SUCCESS" }, { state: "SUCCESS" }],
}]);

const runner = (out: Record<string, { stdout: string; code: number }>): { run: Runner; calls: string[] } => {
  const calls: string[] = [];
  return { calls, run: async (cmd, args) => { const k = [cmd, ...args].join(" "); calls.push(k);
    for (const [prefix, res] of Object.entries(out)) if (k.startsWith(prefix)) return res;
    return { stdout: "", code: 1 }; } };
};

describe("github adapter", () => {
  it("reports auth status from `gh auth status`", async () => {
    const ok = runner({ "gh auth status": { stdout: "Logged in to github.com as m", code: 0 } });
    expect(await makeForge({ preset: "github" }, ok.run)!.authStatus()).toEqual({ ok: true, message: "Logged in to github.com as m" });
    const bad = runner({ "gh auth status": { stdout: "not logged in", code: 1 } });
    expect((await makeForge({ preset: "github" }, bad.run)!.authStatus()).ok).toBe(false);
  });

  it("builds a create-PR command the agent can run verbatim", () => {
    const f = makeForge({ preset: "github" })!;
    const cmd = f.createPrCommand({ title: "PAY-42: fix retry", bodyFile: "/tmp/body.md", base: "main", head: "bugfix/PAY-42" });
    expect(cmd).toBe(`gh pr create --base 'main' --head 'bugfix/PAY-42' --title 'PAY-42: fix retry' --body-file '/tmp/body.md'`);
  });

  it("quotes shell metacharacters in the title", () => {
    const f = makeForge({ preset: "github" })!;
    expect(f.createPrCommand({ title: "it's $(broken)", bodyFile: "/b", base: "main", head: "h" }))
      .toContain(`--title 'it'\\''s $(broken)'`);
  });

  it("finds the PR for a branch and normalises it to PrInfo", async () => {
    const r = runner({ "gh pr list": { stdout: GH_PR_LIST, code: 0 } });
    const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/repo", "bugfix/PAY-42");
    expect(pr).toEqual({ number: 482, url: "https://github.com/acme/pay/pull/482", state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS", mergeable: "MERGEABLE", lastSeenEventAt: "2026-09-25T10:00:00Z" });
    expect(r.calls[0]).toContain("--head bugfix/PAY-42");
  });

  it("returns null when no PR exists and when gh fails", async () => {
    expect(await makeForge({ preset: "github" }, runner({ "gh pr list": { stdout: "[]", code: 0 } }).run)!.findPr("/r", "b")).toBeNull();
    expect(await makeForge({ preset: "github" }, runner({}).run)!.findPr("/r", "b")).toBeNull();
  });

  it("reports failing checks as FAILURE", async () => {
    const mixed = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0], statusCheckRollup: [{ state: "SUCCESS" }, { state: "FAILURE" }] }]);
    const pr = await makeForge({ preset: "github" }, runner({ "gh pr list": { stdout: mixed, code: 0 } }).run)!.findPr("/r", "b");
    expect(pr!.checks).toBe("FAILURE");
  });

  it("makeForge returns null for an unconfigured or unsupported forge", () => {
    expect(makeForge(undefined)).toBeNull();
    expect(makeForge({ preset: "custom" })).toBeNull();   // Phase 2 implements custom
  });

  describe("check rollup (union of StatusContext and CheckRun shapes)", () => {
    it("treats an in-progress CheckRun (status set, conclusion null) as PENDING, not SUCCESS", async () => {
      const running = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0],
        statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }]);
      const r = runner({ "gh pr list --head b --state open": { stdout: running, code: 0 } });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b");
      expect(pr!.checks).toBe("PENDING");
    });

    it("treats a completed CheckRun with conclusion SUCCESS as SUCCESS", async () => {
      const done = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }]);
      const r = runner({ "gh pr list --head b --state open": { stdout: done, code: 0 } });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b");
      expect(pr!.checks).toBe("SUCCESS");
    });

    it("treats a completed CheckRun with conclusion FAILURE as FAILURE", async () => {
      const failed = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }]);
      const r = runner({ "gh pr list --head b --state open": { stdout: failed, code: 0 } });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b");
      expect(pr!.checks).toBe("FAILURE");
    });

    it("treats a check with no recognisable fields at all as PENDING, not SUCCESS", async () => {
      const unknown = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0], statusCheckRollup: [{}] }]);
      const r = runner({ "gh pr list --head b --state open": { stdout: unknown, code: 0 } });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b");
      expect(pr!.checks).toBe("PENDING");
    });
  });

  describe("findPr prefers the open PR over a stale closed one", () => {
    it("uses the open-state result and does not query --state all when a row is found", async () => {
      const r = runner({ "gh pr list --head bugfix/PAY-42 --state open": { stdout: GH_PR_LIST, code: 0 } });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/repo", "bugfix/PAY-42");
      expect(pr!.number).toBe(482);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).toContain("--state open");
    });

    it("falls back to --state all when the open query returns no rows, and returns the merged PR", async () => {
      const merged = JSON.stringify([{ ...JSON.parse(GH_PR_LIST)[0], state: "MERGED" }]);
      const r = runner({
        "gh pr list --head bugfix/PAY-42 --state open": { stdout: "[]", code: 0 },
        "gh pr list --head bugfix/PAY-42 --state all": { stdout: merged, code: 0 },
      });
      const pr = await makeForge({ preset: "github" }, r.run)!.findPr("/repo", "bugfix/PAY-42");
      expect(pr!.state).toBe("MERGED");
      expect(r.calls).toHaveLength(2);
      expect(r.calls[1]).toContain("--state all");
    });

    it("returns null when both the open and the all queries return no rows", async () => {
      const r = runner({
        "gh pr list --head b --state open": { stdout: "[]", code: 0 },
        "gh pr list --head b --state all": { stdout: "[]", code: 0 },
      });
      expect(await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b")).toBeNull();
    });

    it("returns null without throwing when the open-state query itself exits non-zero", async () => {
      const r = runner({});
      expect(await makeForge({ preset: "github" }, r.run)!.findPr("/r", "b")).toBeNull();
      expect(r.calls).toHaveLength(1);
    });
  });
});
