import { describe, it, expect } from "vitest";
import { githubAdapter } from "../../../src/bugfix/forge/github.js";
import { bitbucketAdapter } from "../../../src/bugfix/forge/bitbucket.js";
import type { ForgeAdapter } from "../../../src/bugfix/forge/types.js";

/**
 * The five assertions every adapter must satisfy, whatever failure mode put it there.
 * `skipAuthStatus` lets the unresolvable-repo pass below opt out of the one method
 * (`authStatus`) whose coverage there would just duplicate the network-down pass — see
 * that pass's comment for why.
 */
function runContract(make: () => ForgeAdapter, { skipAuthStatus = false } = {}) {
  it("getPr never throws and reports unavailability rather than absence", async () => {
    const r = await make().getPr("/r", 7);
    expect(r).toHaveProperty("unavailable");
  });
  it("listReviewEvents never throws and degrades to []", async () => {
    await expect(make().listReviewEvents("/r", 7, "2026-01-01T00:00:00Z")).resolves.toEqual([]);
  });
  it("merge never throws and reports ok:false", async () => {
    await expect(make().merge("/r", 7, "squash")).resolves.toMatchObject({ ok: false });
  });
  it("findPr never throws and returns null when it cannot answer", async () => {
    await expect(make().findPr("/r", "b")).resolves.toBeNull();
  });
  if (!skipAuthStatus) {
    it("authStatus never throws and reports ok:false", async () => {
      await expect(make().authStatus()).resolves.toMatchObject({ ok: false });
    });
  }
}

/**
 * Path 1: the network itself is down. Every call must reach the failing transport and
 * degrade gracefully rather than throw. The Bitbucket adapter resolves `workspace/slug`
 * from the repo's git remote *before* it ever calls the network, so `gitRemoteUrl` is
 * given a URL that parses cleanly here — otherwise every method would bail out at slug
 * resolution and the injected `fetchFn` would never run, which would defeat the point of
 * this test (see the correction below).
 */
const networkDownAdapters: Array<[string, () => ForgeAdapter]> = [
  ["github", () => githubAdapter(async () => ({ stdout: "", code: 1, stderr: "boom" }))],
  ["bitbucket", () => bitbucketAdapter({
    username: "me@example.com", token: () => "t",
    gitRemoteUrl: async () => "git@bitbucket.org:acme/payments.git",
    fetchFn: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch,
  })],
];

describe.each(networkDownAdapters)("the %s adapter satisfies the forge contract when the network is down", (_name, make) => {
  runContract(make);
});

/**
 * Path 2: the network is fine but the repo can't be resolved to a forge slug at all (no
 * git remote, or a remote that isn't a bitbucket.org URL). This is real, distinct
 * behaviour from a network failure — it must be covered too, not traded for path 1's
 * coverage. Only Bitbucket has a slug-resolution step of its own; `gh` resolves the
 * owner/repo implicitly from `repoDir` and has no equivalent failure mode to isolate.
 *
 * `getPr`/`listReviewEvents`/`merge`/`findPr` all resolve a slug before touching the
 * network, so for those four methods `fetchFn` genuinely never runs here — a call would
 * mean slug resolution was skipped, which is exactly the regression this pass exists to
 * catch, so the fetchFn below still throws for them. `authStatus` has no slug-resolution
 * step at all and calls the transport regardless of whether the repo could be resolved,
 * so it's excluded (`skipAuthStatus`) rather than given a fetchFn message that claims a
 * guarantee only the other four methods make; its own coverage lives in the network-down
 * pass above, which is what it actually exercises here too.
 */
const unresolvableRepoAdapters: Array<[string, () => ForgeAdapter]> = [
  ["bitbucket", () => bitbucketAdapter({
    username: "me@example.com", token: () => "t",
    gitRemoteUrl: async () => null,
    fetchFn: (async () => { throw new TypeError("must not be called: no slug was resolved (getPr/listReviewEvents/merge/findPr only)"); }) as unknown as typeof fetch,
  })],
];

describe.each(unresolvableRepoAdapters)("the %s adapter satisfies the forge contract when the repo can't be resolved to a slug", (_name, make) => {
  runContract(make, { skipAuthStatus: true });
});

/**
 * Path 3: `findPr` must query open first, then fall back to any state (spec §4.2), for
 * BOTH adapters — the plain "resolves.toBeNull() on failure" contract above can't see this,
 * since a divergent adapter that only ever queries "open" still resolves to null on failure
 * and to a PR when one is open. This pins the fallback itself, not just the failure path, so
 * the next forge adapter can't add `findPr` without it.
 */
describe("findPr falls back from open to any state on every adapter", () => {
  it("github: falls back to --state all when the open query returns no rows", async () => {
    const calls: string[] = [];
    const f = githubAdapter(async (cmd, args) => {
      const k = [cmd, ...args].join(" "); calls.push(k);
      if (k.includes("--state open")) return { stdout: "[]", code: 0 };
      if (k.includes("--state all")) {
        return { stdout: JSON.stringify([{ number: 9, url: "https://github.com/acme/pay/pull/9", state: "MERGED",
          updatedAt: "2026-09-25T10:00:00Z", headRefOid: "cafe9" }]), code: 0 };
      }
      return { stdout: "", code: 1 };
    });
    const pr = await f.findPr("/repo", "b");
    expect(pr).toMatchObject({ number: 9, state: "MERGED" });
    expect(calls.some(c => c.includes("--state open"))).toBe(true);
    expect(calls.some(c => c.includes("--state all"))).toBe(true);
  });

  it("bitbucket: falls back to the any-state query when the open query returns no rows", async () => {
    const calls: string[] = [];
    const f = bitbucketAdapter({
      username: "me@example.com", token: () => "t",
      gitRemoteUrl: async () => "git@bitbucket.org:acme/payments.git",
      fetchFn: (async (url: any) => {
        const u = decodeURIComponent(String(url)); calls.push(u);
        if (u.includes("/statuses") || u.includes("/conflicts")) return new Response(JSON.stringify({ values: [] }), { status: 200 });
        if (u.includes("/pullrequests?")) {
          if (u.includes('state="OPEN"')) return new Response(JSON.stringify({ values: [] }), { status: 200 });
          return new Response(JSON.stringify({ values: [{ id: 9, state: "MERGED", title: "t",
            updated_on: "2026-09-25T10:00:00Z",
            links: { html: { href: "https://bitbucket.org/acme/payments/pull-requests/9" } },
            source: { branch: { name: "b" }, commit: { hash: "cafe9" } },
            destination: { branch: { name: "main" } }, participants: [] }] }), { status: 200 });
        }
        throw new Error(`unexpected call to ${u}`);
      }) as unknown as typeof fetch,
    });
    const pr = await f.findPr("/repo", "b");
    expect(pr).toMatchObject({ number: 9, state: "MERGED" });
    const listCalls = calls.filter(c => c.includes("/pullrequests?"));
    expect(listCalls.some(c => c.includes('state="OPEN"'))).toBe(true);
    expect(listCalls.some(c => !c.includes('state="OPEN"'))).toBe(true);
  });
});

describe("listOpenPrs — one call per repo, not per PR (spec 2026-10-07 §6)", () => {
  it("github: one gh pr list for my open PRs", async () => {
    const calls: string[] = [];
    const f = githubAdapter(async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { stdout: JSON.stringify([
        { number: 1, url: "https://github.com/a/b/pull/1", state: "OPEN", updatedAt: "t1", headRefOid: "h1", reviewDecision: "APPROVED", mergeable: "MERGEABLE" },
        { number: 2, url: "https://github.com/a/b/pull/2", state: "OPEN", updatedAt: "t2", headRefOid: "h2" },
      ]), code: 0 };
    });
    const r = await f.listOpenPrs!("/repo") as { prs: Array<{ number: number }> };
    expect(r.prs.map(p => p.number)).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    // ~1000 bug PRs plus the user's own: room enough that a bug PR isn't cut off
    expect(calls[0]).toMatch(/^gh pr list --state open --author @me --limit 3000 --json /);
    expect(await githubAdapter(async () => ({ stdout: "", stderr: "gh: not logged in", code: 1 })).listOpenPrs!("/repo")).toEqual({ unavailable: "gh: not logged in" });
  });

  it("bitbucket: pages through the open bugfix/ PRs, one listing per page", async () => {
    const calls: string[] = [];
    const row = (id: number) => ({ id, state: "OPEN", title: "t", updated_on: `t${id}`, links: { html: { href: `https://bitbucket.org/acme/payments/pull-requests/${id}` } },
      source: { branch: { name: `bugfix/X-${id}` }, commit: { hash: `h${id}` } }, destination: { branch: { name: "main" } }, participants: [] });
    const f = bitbucketAdapter({
      username: "me@example.com", token: () => "t", gitRemoteUrl: async () => "git@bitbucket.org:acme/payments.git", sshHostname: async (h: string) => h,
      fetchFn: (async (url: any) => {
        const u = decodeURIComponent(String(url)); calls.push(u);
        if (u.includes("page=2")) return new Response(JSON.stringify({ values: [row(3)] }), { status: 200 });
        return new Response(JSON.stringify({ values: [row(1), row(2)], next: "https://api.bitbucket.org/2.0/repositories/acme/payments/pullrequests?page=2" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const r = await f.listOpenPrs!("/repo") as { prs: Array<{ number: number; checks: unknown; mergeable: unknown }> };
    expect(r.prs.map(p => p.number)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('source.branch.name ~ "bugfix/"'); expect(calls[0]).toContain('state="OPEN"');
    expect(calls[0]).toContain("fields=+values.participants");      // the review decision comes from participants
    expect(r.prs[0]).toMatchObject({ checks: null, mergeable: null });     // not in a listing: read per PR when it changed
  });
});
