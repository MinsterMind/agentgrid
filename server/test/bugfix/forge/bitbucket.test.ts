import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bitbucketAdapter, parseRepoSlug } from "../../../src/bugfix/forge/bitbucket.js";

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
    gitRemoteUrl: async () => "git@bitbucket.org:acme/payments.git" };
};

describe("parseRepoSlug", () => {
  it("reads workspace and slug from SSH and HTTPS remotes", () => {
    expect(parseRepoSlug("git@bitbucket.org:acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("https://me@bitbucket.org/acme/payments.git")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("ssh://git@bitbucket.org/acme/payments")).toEqual({ workspace: "acme", slug: "payments" });
    expect(parseRepoSlug("git@github.com:acme/payments.git")).toBeNull();
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
