import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRole, loadRoles, ensureDefaultRoles } from "../src/store/roles.js";

const md = `---
name: reviewer
avatar: 🧐
model: claude-opus-5
effort: high
permissionMode: default
settingSources: [user, project]
allowedTools: [Read, Grep, "Bash(git *)"]
maxTurns: 40
maxBudgetUsd: 3
---
You review code.`;

describe("parseRole", () => {
  it("parses frontmatter and body", () => {
    const r = parseRole(md, "x");
    expect(r).toEqual({
      name: "reviewer", avatar: "🧐", model: "claude-opus-5", effort: "high",
      permissionMode: "default", settingSources: ["user", "project"],
      allowedTools: ["Read", "Grep", "Bash(git *)"], maxTurns: 40, maxBudgetUsd: 3,
      prompt: "You review code.",
    });
  });
  it("applies defaults and fallback name", () => {
    const r = parseRole(`---\nmodel: claude-opus-5\n---\nHi`, "coder");
    expect(r.name).toBe("coder");
    expect(r.avatar).toBe("🤖");
    expect(r.effort).toBe("high");
    expect(r.permissionMode).toBe("default");
    expect(r.settingSources).toEqual(["user", "project"]);
    expect(r.allowedTools).toEqual([]);
    expect(r.maxTurns).toBe(100);
    expect(r.maxBudgetUsd).toBeUndefined();
  });
  it("throws when model is missing", () => {
    expect(() => parseRole(`---\nname: a\n---\nx`, "a")).toThrow(/model/);
  });
});

describe("loadRoles / ensureDefaultRoles", () => {
  it("loads all .md files sorted by name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    await writeFile(path.join(dir, "b.md"), `---\nmodel: m\n---\nB`);
    await writeFile(path.join(dir, "a.md"), `---\nmodel: m\n---\nA`);
    const roles = await loadRoles(dir);
    expect(roles.map(r => r.name)).toEqual(["a", "b"]);
  });
  it("copies defaults only when the dir is empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
    const defaults = path.resolve("roles");
    await ensureDefaultRoles(dir, defaults);
    const files = await readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["architect.md", "coder.md", "reviewer.md", "tester.md", "devops.md", "demo-prep.md"]));
    await writeFile(path.join(dir, "coder.md"), `---\nmodel: mine\n---\nmine`);
    await ensureDefaultRoles(dir, defaults);
    expect((await loadRoles(dir)).find(r => r.name === "coder")!.model).toBe("mine");
  });
});
