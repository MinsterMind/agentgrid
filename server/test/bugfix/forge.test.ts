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
});
