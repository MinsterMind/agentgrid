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

/** `listReviewEvents` makes two separate `gh api` calls (reviews, then issue comments) —
 *  route each to its half of the fixture by inspecting which REST path was requested. */
const eventsRunner = async (fixtureName: string) => {
  const raw = JSON.parse(await fixture(fixtureName));
  return async (_cmd: string, args: string[]) => {
    const path = args[args.length - 1] as string;
    if (path.includes("/reviews")) return { stdout: JSON.stringify(raw.reviews ?? []), code: 0 };
    if (path.includes("/pulls/") && path.includes("/comments")) return { stdout: JSON.stringify(raw.inline ?? []), code: 0 };
    if (path.includes("/comments")) return { stdout: JSON.stringify(raw.comments ?? []), code: 0 };
    return { stdout: "", code: 1 };
  };
};

describe("listReviewEvents", () => {
  it("normalises reviews and comments, marking bots via REST's `user.type === \"Bot\"` (the [bot] suffix is corroboration, not the primary signal)", async () => {
    const f = githubAdapter(await eventsRunner("events-with-bot.json"));
    const events = await f.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z");
    expect(events).toEqual([
      { kind: "review", state: "CHANGES_REQUESTED", author: "alice", isBot: false, isSelf: false, body: "This leaks a handle.", at: "2026-09-26T09:00:00Z" },
      { kind: "comment", state: "", author: "pytorch-bot[bot]", isBot: true, isSelf: false, body: "Build failed.", at: "2026-09-26T09:05:00Z" },
    ]);
  });

  it("does not treat a plain human `type: User` login as a bot", async () => {
    const f = githubAdapter(await eventsRunner("events-with-bot.json"));
    const events = await f.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z");
    expect(events[0]).toMatchObject({ author: "alice", isBot: false });
  });

  it("treats a `type: Bot` comment author as a bot", async () => {
    const f = githubAdapter(await eventsRunner("events-with-bot.json"));
    const events = await f.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z");
    expect(events[1]).toMatchObject({ author: "pytorch-bot[bot]", isBot: true });
  });

  it("drops events at or before `since`, and never throws on a gh failure", async () => {
    const f = githubAdapter(await eventsRunner("events-with-bot.json"));
    expect(await f.listReviewEvents("/r", 7, "2026-09-26T09:05:00Z")).toEqual([]);

    const broken = githubAdapter(async () => ({ stdout: "", code: 1 }));
    expect(await broken.listReviewEvents("/r", 7, "2026-09-26T08:00:00Z")).toEqual([]);
  });
});

describe("merge", () => {
  /**
   * `--delete-branch` deletes the LOCAL branch as well as the remote one, and the task branch is
   * checked out in the linked worktree at this point — git refuses ("cannot delete branch
   * 'bugfix/…' used by worktree"), `gh` exits 1, and a merge that irreversibly happened comes
   * back as `ok: false`, which `doMerge` turns into "Stage failed". Spec §5.4 forbids exactly
   * that. The remote branch is deleted by the engine instead, after the merge is confirmed, where
   * a failure can only become a cleanup note.
   */
  it("merges with the requested method and never asks gh to delete the branch", async () => {
    const calls: string[][] = [];
    const f = githubAdapter(async (_c, args) => { calls.push(args); return { stdout: "merged", code: 0 }; });
    expect(await f.merge("/r", 7, "squash")).toEqual({ ok: true, message: "merged" });
    expect(calls[0]).toEqual(["pr", "merge", "7", "--squash"]);
    expect(calls[0]).not.toContain("--delete-branch");
    await f.merge("/r", 7, "rebase");
    expect(calls[1]).toContain("--rebase");
  });

  it("reports why a merge was refused instead of throwing", async () => {
    const f = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "Pull request is not mergeable" } as any));
    expect(await f.merge("/r", 7, "squash")).toEqual({ ok: false, message: expect.stringMatching(/not mergeable/i) as unknown as string });
  });
});

describe("createPr", () => {
  const ctx = { title: "PAY-42: Boom", bodyFile: "/a/bt1/pr-body.md", base: "main", head: "bugfix/PAY-42" };

  it("creates the PR and returns the created PR, verified by a read", async () => {
    const calls: string[][] = [];
    const f = githubAdapter(async (_c, args) => {
      calls.push(args);
      if (args[1] === "create") return { stdout: "https://github.com/acme/app/pull/7\n", code: 0 };
      // findPr goes through `gh pr list`, which returns an ARRAY — wrap the fixture.
      return { stdout: `[${await readFile(path.resolve("test/bugfix/fixtures/gh/pr-changes-requested.json"), "utf8")}]`, code: 0 };
    });
    const r = await f.createPr("/r", ctx);
    expect(calls[0]).toEqual(["pr", "create", "--base", "main", "--head", "bugfix/PAY-42",
      "--title", "PAY-42: Boom", "--body-file", "/a/bt1/pr-body.md"]);
    expect(r).toMatchObject({ found: { number: 7, state: "OPEN" } });
  });

  it("reports why it could not create, and never throws", async () => {
    const f = githubAdapter(async () => ({ stdout: "", code: 1, stderr: "a pull request for branch already exists" }));
    const r = await f.createPr("/r", ctx);
    expect(r).toMatchObject({ unavailable: expect.stringMatching(/already exists/i) as unknown as string });
  });

  it("reads the failure text from stdout when a runner puts it there and stderr is empty, rather than the useless generic message", async () => {
    // `??` only falls through on null/undefined, not on "" — a runner that captures a
    // failure's text on stdout with stderr as "" must still surface that text, not
    // `gh exited 1`.
    const f = githubAdapter(async () => ({ stdout: "fatal: branch has no upstream", code: 1, stderr: "" }));
    const r = await f.createPr("/r", ctx);
    expect(r).toMatchObject({ unavailable: "fatal: branch has no upstream" });
  });

  it("adopts an existing PR rather than failing, when one is already open for the branch", async () => {
    // gh refuses a duplicate; the server should then find the PR that already exists.
    let call = 0;
    const f = githubAdapter(async (_c, args) => {
      call += 1;
      if (args[1] === "create") return { stdout: "", code: 1, stderr: "a pull request for branch \"bugfix/PAY-42\" already exists" };
      return { stdout: `[${await readFile(path.resolve("test/bugfix/fixtures/gh/pr-changes-requested.json"), "utf8")}]`, code: 0 };
    });
    const r = await f.createPr("/r", ctx);
    expect(r).toMatchObject({ found: { number: 7 } });
    expect(call).toBeGreaterThan(1);
  });
});

describe("github: import and comment support (spec 2026-10-09 §3.4, §5)", () => {
  it("lists every open PR in the repo for an import, with branch, base and title", async () => {
    const calls: string[][] = [];
    const gh = githubAdapter(async (_c, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify([{ number: 3, url: "u", state: "OPEN", headRefName: "feature/PAY-42-x", baseRefName: "develop", title: "PAY-42 fix", updatedAt: "t" }]) }; });
    const r = await gh.listOpenPrs!("/r", { all: true });
    expect(calls[0]).not.toContain("--author");
    expect(calls[0].join(" ")).toContain("headRefName,baseRefName,title");
    expect(r).toEqual({ prs: [expect.objectContaining({ number: 3, headBranch: "feature/PAY-42-x", baseBranch: "develop", title: "PAY-42 fix" })] });
    await gh.listOpenPrs!("/r");
    expect(calls[1]).toContain("--author");
  });
  it("finds a merged PR naming the key", async () => {
    const gh = githubAdapter(async (_c, args) => ({ code: 0, stdout: args.includes("merged") ? JSON.stringify([{ number: 9, url: "u9", state: "MERGED", headRefName: "bugfix/PAY-42", baseRefName: "develop", title: "PAY-42", updatedAt: "t" }]) : "[]" }));
    expect(await gh.findMergedPr!("/r", "PAY-42")).toMatchObject({ number: 9, state: "MERGED", headBranch: "bugfix/PAY-42" });
    const none = githubAdapter(async () => ({ code: 0, stdout: "[]" }));
    expect(await none.findMergedPr!("/r", "PAY-42")).toBeNull();
  });
  it("marks the user's own comments and reads inline review comments too", async () => {
    const gh = githubAdapter(async (_c, args) => {
      const p = args.join(" ");
      if (p.startsWith("api user")) return { code: 0, stdout: "me\n" };
      if (p.includes("/reviews")) return { code: 0, stdout: "[]" };
      if (p.includes("pulls/5/comments")) return { code: 0, stdout: JSON.stringify([{ user: { login: "rev", type: "User" }, body: "inline", created_at: "2026-10-09T10:00:00Z" }]) };
      return { code: 0, stdout: JSON.stringify([{ user: { login: "me", type: "User" }, body: "mine", created_at: "2026-10-09T10:01:00Z" }]) };
    });
    const ev = await gh.listReviewEvents("/r", 5, "2026-10-09T00:00:00Z");
    expect(ev.map(e => [e.body, e.isSelf])).toEqual([["inline", false], ["mine", true]]);
  });
  it("whoami reports a failure, and asks again next time", async () => {
    let n = 0;
    const gh = githubAdapter(async () => (++n === 1 ? { code: 1, stdout: "", stderr: "not logged in" } : { code: 0, stdout: "me\n" }) as any);
    expect(await gh.whoami!("/r")).toEqual({ unavailable: "not logged in" });
    expect(await gh.whoami!("/r")).toEqual({ login: "me" });
  });
});

describe("final review: forks", () => {
  it("github marks a PR from a fork", async () => {
    const gh = githubAdapter(async () => ({ code: 0, stdout: JSON.stringify([{ number: 3, url: "u", state: "OPEN", headRefName: "main", baseRefName: "main", title: "PAY-1", isCrossRepository: true, updatedAt: "t" }]) }));
    expect(await gh.listOpenPrs!("/r", { all: true })).toEqual({ prs: [expect.objectContaining({ crossRepo: true })] });
  });
});

describe("final review: merged search is whole-word (I6)", () => {
  it("github skips a merged PR for a longer key", async () => {
    const gh = githubAdapter(async () => ({ code: 0, stdout: JSON.stringify([
      { number: 8, url: "u8", state: "MERGED", headRefName: "bugfix/PAY-410", baseRefName: "develop", title: "PAY-410", updatedAt: "t" },
      { number: 9, url: "u9", state: "MERGED", headRefName: "x", baseRefName: "develop", title: "PAY-41: fix", updatedAt: "t" }]) }));
    expect(await gh.findMergedPr!("/r", "PAY-41")).toMatchObject({ number: 9 });
  });
});
