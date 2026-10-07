import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bitbucketAdapter, parseRepoSlug, hostnameFromSshConfig } from "../../../src/bugfix/forge/bitbucket.js";

const fx = (n: string) => readFile(path.resolve("test/bugfix/fixtures/bb", n), "utf8");
const json = async (n: string, status = 200) => new Response(await fx(n), { status, headers: { "content-type": "application/json" } });

/** Records every request so a test can assert the URL, method and auth header. */
function recorder(reply: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string | null }> = [];
  const fetchFn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"), body: init?.body ? String(init.body) : null });
    return reply(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

// A plain default parameter can't tell "omitted" from "explicitly undefined" (both trigger
// the default), which would make `deps(fetchFn, undefined)` silently fall back to "tok" and
// defeat the "no token" tests below. Rest-args preserve the distinction.
const deps = (fetchFn: typeof fetch, ...tokenArg: [string | undefined] | []) => {
  const token = tokenArg.length > 0 ? tokenArg[0] : "tok";
  // `repoDir` in these tests ("/r") is never a real git checkout, so slug resolution is
  // injected directly rather than shelling out to a nonexistent repo.
  return { username: "me@example.com", token: () => token, fetchFn,
    gitRemoteUrl: async () => "git@bitbucket.org:acme/payments.git",
    // Never shell out to the real ssh from a unit test: an alias resolves to itself unless a
    // test says otherwise.
    sshHostname: async (host: string) => host };
};

describe("parseRepoSlug", () => {
  it("reads workspace and slug from SSH and HTTPS remotes", () => {
    expect(parseRepoSlug("git@bitbucket.org:acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("https://me@bitbucket.org/acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("ssh://git@bitbucket.org/acme/payments")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("git@github.com:acme/payments.git")).toBeNull();
  });

  it("accepts a trailing slash, an explicit port and a capitalised host", () => {
    const want = { workspace: "gruve-team", slug: "pluseai_platform" };
    expect(parseRepoSlug("https://bitbucket.org/gruve-team/pluseai_platform/")).toEqual(want);
    expect(parseRepoSlug("https://bitbucket.org/gruve-team/pluseai_platform.git/")).toEqual(want);
    expect(parseRepoSlug("ssh://git@bitbucket.org:22/gruve-team/pluseai_platform.git")).toEqual(want);
    expect(parseRepoSlug("git@Bitbucket.org:gruve-team/pluseai_platform.git")).toEqual(want);
  });

  it("still refuses a host that merely contains bitbucket.org", () => {
    expect(parseRepoSlug("git@evilbitbucket.org:acme/payments.git")).toBeNull();
    expect(parseRepoSlug("https://bitbucket.org.evil.com/acme/payments.git")).toBeNull();
  });
});

describe("hostnameFromSshConfig", () => {
  it("reads the hostname line out of `ssh -G`", () => {
    expect(hostnameFromSshConfig("user git\nhostname bitbucket.org\nport 22\n")).toBe("bitbucket.org");
    expect(hostnameFromSshConfig("user git\nport 22\n")).toBeNull();
  });
});

// The reported case: a work account behind an SSH host alias, `Host bitbucket.org-gruve` in
// ~/.ssh/config with `HostName bitbucket.org`. git resolves it through ssh; AgentGrid must too.
describe("a remote behind an SSH host alias", () => {
  const ALIAS = "git@bitbucket.org-gruve:gruve-team/pluseai_platform.git";

  it("resolves the alias through ssh and calls the API for the right repository", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    const asked: string[] = [];
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => ALIAS,
      sshHostname: async (h: string) => { asked.push(h); return h === "bitbucket.org-gruve" ? "bitbucket.org" : h; } };
    const r = await bitbucketAdapter(d).getPr("/r", 7);
    expect(r).toMatchObject({ found: { number: 7 } });
    expect(asked).toEqual(["bitbucket.org-gruve"]);
    expect(calls[0].url).toContain("/repositories/gruve-team/pluseai_platform/pullrequests/7");
  });

  it("explains an alias that does not lead to bitbucket.org, naming the remote and the host", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-open.json"));
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => ALIAS, sshHostname: async () => "git.example.com" };
    const r = await bitbucketAdapter(d).getPr("/r", 7) as { unavailable: string };
    expect(r.unavailable).toContain(ALIAS);
    expect(r.unavailable).toMatch(/bitbucket\.org-gruve/);
    expect(r.unavailable).toMatch(/git\.example\.com/);
    expect(calls).toHaveLength(0);
  });
});

describe("why a repository could not be resolved", () => {
  it("never hands ssh a host that would read as an option", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-open.json"));
    const asked: string[] = [];
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => "git@-oProxyCommand=touch_x:acme/payments.git",
      sshHostname: async (h: string) => { asked.push(h); return "bitbucket.org"; } };
    const r = await bitbucketAdapter(d).getPr("/r", 7);
    expect(asked).toEqual([]);
    expect(r).toHaveProperty("unavailable");
    expect(calls).toHaveLength(0);
  });


  it("says when there is no origin remote", async () => {
    const { fetchFn } = recorder(async () => json("pr-open.json"));
    const r = await bitbucketAdapter({ ...deps(fetchFn), gitRemoteUrl: async () => null }).getPr("/repo", 7) as { unavailable: string };
    expect(r.unavailable).toMatch(/no "origin" remote/);
    expect(r.unavailable).toContain("/repo");
  });

  it("never echoes a password embedded in the remote URL", async () => {
    const { fetchFn } = recorder(async () => json("pr-open.json"));
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => "https://x-token-auth:s3cr3t@github.com/acme/payments.git" };
    const r = await bitbucketAdapter(d).getPr("/r", 7) as { unavailable: string };
    expect(r.unavailable).not.toContain("s3cr3t");
    expect(r.unavailable).toContain("github.com/acme/payments.git");
  });

  it("merge says why, too", async () => {
    const { fetchFn } = recorder(async () => json("pr-open.json"));
    const r = await bitbucketAdapter({ ...deps(fetchFn), gitRemoteUrl: async () => null }).merge("/repo", 7, "squash");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no "origin" remote/);
  });
});

describe("authStatus", () => {
  it("names the missing environment variable when there is no token", async () => {
    const { fetchFn } = recorder(async () => json("user.json"));
    const r = await bitbucketAdapter(deps(fetchFn, undefined)).authStatus();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/BITBUCKET_API_TOKEN/);
  });

  it("says the token was refused, not that the forge is down", async () => {
    const { fetchFn } = recorder(async () => new Response("", { status: 401 }));
    const r = await bitbucketAdapter(deps(fetchFn)).authStatus();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/refused|not accepted|401/i);
    expect(r.message).not.toMatch(/unreachable/i);
  });

  it("names the authenticated account, and sends Basic auth", async () => {
    const { calls, fetchFn } = recorder(async () => json("user.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).authStatus();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/me@example\.com|Manoj/);
    expect(calls[0].url).toBe("https://api.bitbucket.org/2.0/user");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
  });
});

describe("getPr", () => {
  it("normalises an open PR", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/statuses") ? new Response(JSON.stringify({ values: [{ state: "SUCCESSFUL" }] }), { status: 200 })
      : url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7);
    expect(r).toMatchObject({ found: { number: 7, state: "OPEN", checks: "SUCCESS", headSha: "abc123" } });
  });

  it("maps MERGED and DECLINED, and treats a 404 as no PR", async () => {
    const merged = recorder(async url => url.includes("/statuses") || url.includes("/conflicts")
      ? new Response(JSON.stringify({ values: [] }), { status: 200 }) : json("pr-merged.json"));
    expect(await bitbucketAdapter(deps(merged.fetchFn)).getPr("/r", 7)).toMatchObject({ found: { state: "MERGED" } });

    const gone = recorder(async () => new Response("", { status: 404 }));
    expect(await bitbucketAdapter(deps(gone.fetchFn)).getPr("/r", 7)).toEqual({ found: null });
  });

  it("treats a 429 and a network failure as unavailable, never as a missing PR", async () => {
    const limited = recorder(async () => new Response("", { status: 429 }));
    expect(await bitbucketAdapter(deps(limited.fetchFn)).getPr("/r", 7)).toMatchObject({ unavailable: expect.stringMatching(/rate|429/i) as unknown as string });

    const down = recorder(async () => { throw new TypeError("network down"); });
    expect(await bitbucketAdapter(deps(down.fetchFn)).getPr("/r", 7)).toMatchObject({ unavailable: expect.stringMatching(/network down/) as unknown as string });
  });

  it("never throws, whatever the body is", async () => {
    const junk = recorder(async () => new Response("not json", { status: 200 }));
    expect(await bitbucketAdapter(deps(junk.fetchFn)).getPr("/r", 7)).toHaveProperty("unavailable");
  });
});

describe("findPr", () => {
  it("queries by source branch, open first", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-open.json"))] }), { status: 200 }));
    const pr = await bitbucketAdapter(deps(fetchFn)).findPr("/r", "bugfix/PAY-42");
    expect(pr).toMatchObject({ number: 7 });
    expect(decodeURIComponent(calls[0].url)).toContain('source.branch.name="bugfix/PAY-42"');
    expect(decodeURIComponent(calls[0].url)).toContain('state="OPEN"');
  });

  it("does not query any-state when the open query already found a row (mirrors GitHub's findPrImpl)", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-open.json"))] }), { status: 200 }));
    await bitbucketAdapter(deps(fetchFn)).findPr("/r", "bugfix/PAY-42");
    const listCalls = calls.filter(c => c.url.includes("/pullrequests?"));
    expect(listCalls).toHaveLength(1);
  });

  it("falls back to any state (spec §4.2) when the open query returns no rows, and returns the merged PR", async () => {
    let openQueried = false;
    const { calls, fetchFn } = recorder(async url => {
      if (url.includes("/statuses") || url.includes("/conflicts")) return new Response(JSON.stringify({ values: [] }), { status: 200 });
      if (url.includes("/pullrequests?")) {
        if (decodeURIComponent(url).includes('state="OPEN"')) { openQueried = true; return new Response(JSON.stringify({ values: [] }), { status: 200 }); }
        return new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-merged.json"))] }), { status: 200 });
      }
      throw new Error(`unexpected call to ${url}`);
    });
    const pr = await bitbucketAdapter(deps(fetchFn)).findPr("/r", "bugfix/PAY-42");
    expect(openQueried).toBe(true);
    expect(pr).toMatchObject({ number: 7, state: "MERGED" });
    const listCalls = calls.filter(c => c.url.includes("/pullrequests?"));
    expect(listCalls).toHaveLength(2);
    expect(decodeURIComponent(listCalls[1].url)).toContain('source.branch.name="bugfix/PAY-42"');
    expect(decodeURIComponent(listCalls[1].url)).not.toContain('state="OPEN"');
  });

  it("returns null when both the open and the any-state queries return no rows", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/pullrequests?") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify({ values: [] }), { status: 200 }));
    expect(await bitbucketAdapter(deps(fetchFn)).findPr("/r", "b")).toBeNull();
  });

  it("returns null without throwing when the open-state query itself fails", async () => {
    const { calls, fetchFn } = recorder(async () => new Response("", { status: 500 }));
    expect(await bitbucketAdapter(deps(fetchFn)).findPr("/r", "b")).toBeNull();
    const listCalls = calls.filter(c => c.url.includes("/pullrequests?"));
    expect(listCalls).toHaveLength(1);   // no retry with the any-state query on a hard failure
  });
});

describe("an unresolvable repository", () => {
  it("getPr reports unavailable, never {found: null}, and makes no HTTP call when the origin can't be read", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-open.json"));
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => null };
    const r = await bitbucketAdapter(d).getPr("/r", 7);
    expect(r).toHaveProperty("unavailable");
    expect(r).not.toEqual({ found: null });
    expect(calls).toHaveLength(0);
  });

  it("getPr reports unavailable when the origin isn't a Bitbucket remote", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-open.json"));
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => "git@github.com:acme/payments.git" };
    const r = await bitbucketAdapter(d).getPr("/r", 7);
    expect(r).toHaveProperty("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("findPr returns null and makes no HTTP call when the origin can't be read", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-open.json"));
    const d = { ...deps(fetchFn), gitRemoteUrl: async () => null };
    const pr = await bitbucketAdapter(d).findPr("/r", "bugfix/PAY-42");
    expect(pr).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("review state", () => {
  it("an outstanding changes-requested beats any number of approvals", async () => {
    const pr = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: true,  state: "approved" },
      { user: { nickname: "bob" },   approved: true,  state: "approved" },
      { user: { nickname: "carol" }, approved: false, state: "changes_requested" }] };
    const { fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify(pr), { status: 200 }));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7))
      .toMatchObject({ found: { reviewDecision: "CHANGES_REQUESTED" } });
  });

  it("reports APPROVED only when someone approved and nobody is objecting", async () => {
    const approved = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: true, state: "approved" }] };
    const none = { ...JSON.parse(await fx("pr-open.json")), participants: [
      { user: { nickname: "alice" }, approved: false, state: null }] };
    const mk = (body: unknown) => recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 })).fetchFn;
    expect(await bitbucketAdapter(deps(mk(approved))).getPr("/r", 7)).toMatchObject({ found: { reviewDecision: "APPROVED" } });
    expect(await bitbucketAdapter(deps(mk(none))).getPr("/r", 7)).toMatchObject({ found: { reviewDecision: null } });
  });

  it("normalises activity into review and comment events, oldest first, strictly after `since`", async () => {
    const { fetchFn } = recorder(async () => json("activity.json"));
    const events = await bitbucketAdapter(deps(fetchFn)).listReviewEvents("/r", 7, "2026-09-29T09:00:00Z");
    expect(events.map(e => [e.kind, e.state, e.author, e.isBot])).toEqual([
      ["comment", "", "alice", false],
      ["review", "CHANGES_REQUESTED", "carol", false],
    ]);
    expect(events[0].body).toMatch(/leaks a handle/);
  });

  it("returns [] rather than throwing when the activity feed cannot be read", async () => {
    const { fetchFn } = recorder(async () => new Response("", { status: 500 }));
    expect(await bitbucketAdapter(deps(fetchFn)).listReviewEvents("/r", 7, "2026-09-29T09:00:00Z")).toEqual([]);
  });
});

describe("conflicts", () => {
  it("reports CONFLICTING when the conflicts endpoint lists any", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/conflicts") ? new Response(JSON.stringify({ values: [{ path: "src/a.ts" }] }), { status: 200 })
      : url.includes("/statuses") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7)).toMatchObject({ found: { mergeable: "CONFLICTING" } });
  });

  it("leaves mergeable null when the conflicts endpoint is unavailable — never guesses MERGEABLE", async () => {
    const { fetchFn } = recorder(async url =>
      url.includes("/conflicts") ? new Response("", { status: 503 })
      : url.includes("/statuses") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    expect(await bitbucketAdapter(deps(fetchFn)).getPr("/r", 7)).toMatchObject({ found: { mergeable: null } });
  });
});

describe("merge", () => {
  it("maps squash and merge, and posts close_source_branch", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-merged.json"));
    const f = bitbucketAdapter(deps(fetchFn));
    expect(await f.merge("/r", 7, "squash")).toMatchObject({ ok: true });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ merge_strategy: "squash", close_source_branch: true });
    await f.merge("/r", 7, "merge");
    expect(JSON.parse(calls[1].body!)).toMatchObject({ merge_strategy: "merge_commit" });
  });

  it("REFUSES rebase rather than silently fast-forwarding", async () => {
    const { calls, fetchFn } = recorder(async () => json("pr-merged.json"));
    const r = await bitbucketAdapter(deps(fetchFn)).merge("/r", 7, "rebase");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rebase/i);
    expect(calls).toEqual([]);            // nothing was sent
  });

  it("reports the forge's reason when a merge is refused", async () => {
    const { fetchFn } = recorder(async () => new Response(JSON.stringify({ error: { message: "pull request has conflicts" } }), { status: 400 }));
    expect(await bitbucketAdapter(deps(fetchFn)).merge("/r", 7, "squash"))
      .toMatchObject({ ok: false, message: expect.stringMatching(/conflicts/i) as unknown as string });
  });
});

describe("createPr", () => {
  it("posts the title, branches and the body read from the file", async () => {
    const { calls, fetchFn } = recorder(async url =>
      url.includes("/statuses") || url.includes("/conflicts") ? new Response(JSON.stringify({ values: [] }), { status: 200 })
      : json("pr-open.json"));
    const body = path.join(await mkdtemp(path.join(tmpdir(), "bb-")), "pr-body.md");
    await writeFile(body, "## What broke\nA handle leak.\n");
    const r = await bitbucketAdapter(deps(fetchFn)).createPr("/r", { title: "PAY-42: Boom", bodyFile: body, base: "main", head: "bugfix/PAY-42" });
    const sent = JSON.parse(calls[0].body!);
    expect(sent).toMatchObject({ title: "PAY-42: Boom", source: { branch: { name: "bugfix/PAY-42" } }, destination: { branch: { name: "main" } } });
    expect(sent.description).toMatch(/handle leak/);
    expect(r).toMatchObject({ found: { number: 7 } });
  });

  it("adopts an existing PR when the forge refuses a duplicate", async () => {
    let post = 0;
    const { fetchFn } = recorder(async (url, init) => {
      if (init?.method === "POST") { post += 1; return new Response(JSON.stringify({ error: { message: "branch already has an open pull request" } }), { status: 400 }); }
      if (url.includes("/statuses") || url.includes("/conflicts")) return new Response(JSON.stringify({ values: [] }), { status: 200 });
      return new Response(JSON.stringify({ values: [JSON.parse(await fx("pr-open.json"))] }), { status: 200 });
    });
    const body = path.join(await mkdtemp(path.join(tmpdir(), "bb-")), "pr-body.md");
    await writeFile(body, "b");
    expect(await bitbucketAdapter(deps(fetchFn)).createPr("/r", { title: "t", bodyFile: body, base: "main", head: "bugfix/PAY-42" }))
      .toMatchObject({ found: { number: 7 } });
    expect(post).toBe(1);
  });
});

describe("bitbucket: import and comment support (spec 2026-10-09 §3.4, §5)", () => {
  const prBody = { id: 3, links: { html: { href: "u3" } }, state: "OPEN", title: "PAY-42 fix", updated_on: "t",
    source: { branch: { name: "feature/PAY-42-x" }, commit: { hash: "abc" } }, destination: { branch: { name: "develop" } } };
  it("lists every open PR when asked for all, with branch, base and title", async () => {
    const { calls, fetchFn } = recorder(async () => new Response(JSON.stringify({ values: [prBody] }), { status: 200 }));
    const r = await bitbucketAdapter(deps(fetchFn)).listOpenPrs!("/r", { all: true });
    expect(decodeURIComponent(calls[0].url)).not.toContain("bugfix/");
    expect(r).toEqual({ prs: [expect.objectContaining({ number: 3, headBranch: "feature/PAY-42-x", baseBranch: "develop", title: "PAY-42 fix" })] });
    await bitbucketAdapter(deps(fetchFn)).listOpenPrs!("/r");
    expect(decodeURIComponent(calls[1].url)).toContain("bugfix/");
  });
  it("finds a merged PR naming the key", async () => {
    const { calls, fetchFn } = recorder(async () => new Response(JSON.stringify({ values: [{ ...prBody, state: "MERGED" }] }), { status: 200 }));
    expect(await bitbucketAdapter(deps(fetchFn)).findMergedPr!("/r", "PAY-42")).toMatchObject({ number: 3, state: "MERGED" });
    expect(decodeURIComponent(calls[0].url)).toContain('state="MERGED"');
  });
  it("whoami is the account's nickname, and its comments are the user's own", async () => {
    const { fetchFn } = recorder(async url => url.endsWith("/user") ? new Response(JSON.stringify({ nickname: "alice", account_id: "x1" }), { status: 200 }) : json("activity.json"));
    const bb = bitbucketAdapter(deps(fetchFn));
    expect(await bb.whoami!("/r")).toEqual({ login: "alice" });
    const events = await bb.listReviewEvents("/r", 7, "2026-09-29T09:00:00Z");
    expect(events.map(e => [e.author, e.isSelf])).toEqual([["alice", true], ["carol", false]]);
  });
});
