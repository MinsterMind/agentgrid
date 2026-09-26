import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { makeForge, type Runner } from "../../src/bugfix/forge/index.js";
import { githubAdapter } from "../../src/bugfix/forge/github.js";

const fixture = (name: string) => readFile(path.resolve("test/bugfix/fixtures/gh", name), "utf8");

/** One recorded `gh pr list` payload — the shape the adapter must survive. */
const GH_PR_LIST = JSON.stringify([{
  number: 482, url: "https://github.com/acme/pay/pull/482", state: "OPEN", isDraft: false,
  reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", updatedAt: "2026-09-25T10:00:00Z",
  headRefOid: "cafe482", statusCheckRollup: [{ state: "SUCCESS" }, { state: "SUCCESS" }],
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
      reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "cafe482", lastSeenEventAt: "2026-09-25T10:00:00Z" });
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

describe("getPr", () => {
  it("returns the PR when gh succeeds", async () => {
    const stdout = await fixture("pr-changes-requested.json");
    const f = githubAdapter(async () => ({ stdout, code: 0 }));
    const r = await f.getPr("/r", 7);
    expect(r).toEqual({ found: { number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED", checks: "SUCCESS", mergeable: "MERGEABLE", headSha: "abc123",
      lastSeenEventAt: "2026-09-26T09:00:00Z" } });
  });

  it("distinguishes a missing PR from a gh failure", async () => {
    const missing = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "no pull requests found" } as any));
    expect(await missing.getPr("/r", 7)).toEqual({ found: null });

    const broken = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "could not connect to api.github.com" } as any));
    const r = await broken.getPr("/r", 7);
    expect(r).toMatchObject({ unavailable: expect.stringMatching(/could not connect/i) });

    const garbage = githubAdapter(async () => ({ stdout: "not json", code: 0 }));
    expect(await garbage.getPr("/r", 7)).toMatchObject({ unavailable: expect.stringMatching(/could not read/i) });
  });

  it("reports a conflicting PR as such", async () => {
    const f = githubAdapter(async () => ({ stdout: await fixture("pr-conflicting.json"), code: 0 }));
    const r = await f.getPr("/r", 7);
    expect(r).toMatchObject({ found: { mergeable: "CONFLICTING" } });
  });

  it("never reports `found` for valid JSON that isn't shaped like a PR", async () => {
    for (const body of ["{}", "[]", "null", '{"number":"seven"}']) {
      const f = githubAdapter(async () => ({ stdout: body, code: 0 }));
      const r = await f.getPr("/r", 7);
      expect(r).toMatchObject({ unavailable: expect.stringMatching(/did not look like a pull request/i) });
    }
  });
});

describe("listReviewEvents", () => {
  it("normalises reviews, comments and checks, marking bots by the `[bot]` login suffix (the real gh shape has no is_bot/isBot field)", async () => {
    const f = githubAdapter(async () => ({ stdout: await fixture("events-with-bot.json"), code: 0 }));
    const events = await f.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z");
    expect(events).toEqual([
      { kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, body: "This leaks a handle.", at: "2026-09-26T09:00:00Z" },
      { kind: "comment", state: "", author: "ci-bot[bot]", isBot: true, body: "Build failed.", at: "2026-09-26T09:05:00Z" },
    ]);
  });

  it("does not treat a plain human login as a bot", async () => {
    const f = githubAdapter(async () => ({ stdout: await fixture("events-with-bot.json"), code: 0 }));
    const events = await f.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z");
    expect(events[0]).toMatchObject({ author: "alice", isBot: false });
  });

  it("drops events at or before `since`, and never throws on a gh failure", async () => {
    const f = githubAdapter(async () => ({ stdout: await fixture("events-with-bot.json"), code: 0 }));
    expect(await f.listReviewEvents("/r", 7, "2026-09-26T09:05:00Z")).toEqual([]);

    const broken = githubAdapter(async () => ({ stdout: "", code: 1 }));
    expect(await broken.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z")).toEqual([]);
  });
});

describe("merge", () => {
  it("merges with the requested method and asks for the branch to be deleted", async () => {
    const calls: string[][] = [];
    const f = githubAdapter(async (_c, args) => { calls.push(args); return { stdout: "merged", code: 0 }; });
    expect(await f.merge("/r", 7, "squash")).toEqual({ ok: true, message: "merged" });
    expect(calls[0]).toEqual(["pr", "merge", "7", "--squash", "--delete-branch"]);
    await f.merge("/r", 7, "rebase");
    expect(calls[1]).toContain("--rebase");
  });

  it("reports why a merge was refused instead of throwing", async () => {
    const f = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "Pull request is not mergeable" } as any));
    expect(await f.merge("/r", 7, "squash")).toEqual({ ok: false, message: expect.stringMatching(/not mergeable/i) as unknown as string });
  });
});
