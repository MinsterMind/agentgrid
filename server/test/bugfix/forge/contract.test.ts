import { describe, it, expect } from "vitest";
import { githubAdapter } from "../../../src/bugfix/forge/github.js";
import { bitbucketAdapter } from "../../../src/bugfix/forge/bitbucket.js";
import type { ForgeAdapter } from "../../../src/bugfix/forge/types.js";

/** Every adapter must satisfy these, whatever it talks to. */
const adapters: Array<[string, () => ForgeAdapter]> = [
  ["github", () => githubAdapter(async () => ({ stdout: "", code: 1, stderr: "boom" }))],
  ["bitbucket", () => bitbucketAdapter({ username: "me@example.com", token: () => "t",
    fetchFn: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch })],
];

describe.each(adapters)("the %s adapter satisfies the forge contract", (_name, make) => {
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
  it("authStatus never throws and reports ok:false", async () => {
    await expect(make().authStatus()).resolves.toMatchObject({ ok: false });
  });
});
