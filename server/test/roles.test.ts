import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir, copyFile, rm } from "node:fs/promises";
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
      prompt: "You review code.", description: "You review code.",
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
  // A role added to AgentGrid after someone first ran it never reached them: seeding only ran
  // into an empty dir, so a machine set up before `bugfix` existed failed every bug fix with
  // "the bugfix role could not be resolved". New defaults must arrive; deletions must stick.
  describe("defaults added in a later version", () => {
    const defaults = path.resolve("roles");
    const ORIGINAL = ["architect.md", "coder.md", "demo-prep.md", "devops.md", "reviewer.md", "tester.md"];
    const legacyDir = async (files = ORIGINAL) => {
      const dir = await mkdtemp(path.join(tmpdir(), "roles-"));
      for (const f of files) await copyFile(path.join(defaults, f), path.join(dir, f));
      return dir;
    };

    it("reach an install seeded before they existed, leaving its own edits alone", async () => {
      const dir = await legacyDir();
      await writeFile(path.join(dir, "coder.md"), `---\nmodel: mine\n---\nmine`);
      await ensureDefaultRoles(dir, defaults);
      const roles = await loadRoles(dir);
      expect(roles.map(r => r.name)).toContain("bugfix");
      expect(roles.find(r => r.name === "coder")!.model).toBe("mine");
    });

    it("do not bring back an original role the user deleted before upgrading", async () => {
      const dir = await legacyDir(ORIGINAL.filter(f => f !== "devops.md"));
      await ensureDefaultRoles(dir, defaults);
      const files = await readdir(dir);
      expect(files).toContain("bugfix.md");
      expect(files).not.toContain("devops.md");
    });

    it("are copied once: deleting one afterwards sticks", async () => {
      const dir = await legacyDir();
      await ensureDefaultRoles(dir, defaults);
      await rm(path.join(dir, "bugfix.md"));
      await ensureDefaultRoles(dir, defaults);
      expect(await readdir(dir)).not.toContain("bugfix.md");
    });

    it("never overwrite a same-named role the user wrote themselves", async () => {
      const dir = await legacyDir();
      await writeFile(path.join(dir, "bugfix.md"), `---\nmodel: mine\n---\nmine`);
      await ensureDefaultRoles(dir, defaults);
      expect((await loadRoles(dir)).find(r => r.name === "bugfix")!.model).toBe("mine");
    });
  });
});

describe("role description", () => {
  it("reads description from frontmatter", () => {
    expect(parseRole("---\nmodel: m\ndescription: Writes code.\n---\nYou are…", "x").description).toBe("Writes code.");
  });
  // Review Focus 1
  it("falls back to the prompt's first sentence for a role written before descriptions existed", () => {
    expect(parseRole("---\nmodel: m\n---\nYou review diffs carefully. You never edit.", "x").description).toBe("You review diffs carefully.");
    expect(parseRole("---\nmodel: m\n---\n", "x").description).toBe("");
  });
  it("every shipped role has its own description", async () => {
    for (const r of await loadRoles(path.resolve("roles"))) expect(r.description.length).toBeGreaterThan(10);
  });
});
