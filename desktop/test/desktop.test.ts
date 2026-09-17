import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loginShellEnv } from "../src/shell-env.js";
import { PrefsStore } from "../src/prefs.js";

describe("loginShellEnv", () => {
  it("captures the login shell's PATH and drops Claude Code markers", () => {
    const env = loginShellEnv("/bin/sh");
    expect(env.PATH).toBeTruthy();
    expect(Object.keys(env).some(k => /^CLAUDE/i.test(k))).toBe(false);
    expect(env._).toBeUndefined();
  });
  it("returns {} for a shell that fails", () => {
    expect(loginShellEnv("/nonexistent/shell")).toEqual({});
  });
});

describe("PrefsStore", () => {
  it("round-trips and drops empty values", async () => {
    const p = new PrefsStore(await mkdtemp(path.join(tmpdir(), "prefs-")));
    expect(p.read()).toEqual({});
    expect(p.write({ browseRoot: "/x" })).toEqual({ browseRoot: "/x" });
    expect(p.write({ home: "/h" })).toEqual({ browseRoot: "/x", home: "/h" });
    expect(p.write({ browseRoot: "" })).toEqual({ home: "/h" });
    expect(new PrefsStore(path.dirname(p["file"])).read()).toEqual({ home: "/h" });
  });
});
