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
