import { describe, it, expect } from "vitest";
import { stripForgeSecrets } from "../src/env.js";

describe("stripForgeSecrets", () => {
  it("removes BITBUCKET_API_TOKEN, GH_TOKEN and GITHUB_TOKEN, case-insensitively, and keeps everything else", () => {
    const out = stripForgeSecrets({
      PATH: "/bin",
      HOME: "/h",
      BITBUCKET_API_TOKEN: "secret-bb",
      GH_TOKEN: "secret-gh",
      GITHUB_TOKEN: "secret-ghlegacy",
      github_token: "secret-lower",
    });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("is a no-op when none of the secret vars are present", () => {
    expect(stripForgeSecrets({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
