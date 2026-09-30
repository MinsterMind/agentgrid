import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMcpServers, toolPrefixFor } from "../../src/bugfix/mcp-discovery.js";

/** A fake home: `~/.claude.json` plus `~/.claude/settings.json`, both optional. */
async function fakeHome(claudeJson?: unknown, settings?: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-mcp-"));
  if (claudeJson !== undefined) await writeFile(path.join(home, ".claude.json"), typeof claudeJson === "string" ? claudeJson : JSON.stringify(claudeJson));
  if (settings !== undefined) {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return home;
}

describe("toolPrefixFor", () => {
  // Both verified against a live session's tool list on 2026-09-30 (spec §2).
  it("derives the prefix Claude Code uses for an account connector", () => {
    expect(toolPrefixFor("claude.ai Claude Docs")).toBe("mcp__claude_ai_Claude_Docs");
    expect(toolPrefixFor("claude.ai Kite mcp")).toBe("mcp__claude_ai_Kite_mcp");
  });
  it("derives the plain prefix for a locally defined server", () => {
    expect(toolPrefixFor("atlassian")).toBe("mcp__atlassian");
  });
  it("replaces every space, not just the first", () => {
    expect(toolPrefixFor("claude.ai Google Calendar")).toBe("mcp__claude_ai_Google_Calendar");
  });
});

describe("discoverMcpServers", () => {
  it("finds user-scoped servers", async () => {
    const home = await fakeHome({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } } });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toEqual([{ name: "atlassian", toolPrefix: "mcp__atlassian", origin: "user" }]);
    expect(d.problems).toEqual([]);
  });

  it("finds project-scoped servers and records which project they came from", async () => {
    const home = await fakeHome({ projects: { "/Users/x/repo": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app" } } } } });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toEqual([{ name: "linear", toolPrefix: "mcp__linear", origin: "project", originDetail: "/Users/x/repo" }]);
  });

  it("finds a repo's .mcp.json when a repo is given", async () => {
    const home = await fakeHome({});
    const repo = await mkdtemp(path.join(os.tmpdir(), "agentgrid-repo-"));
    await writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["-y", "jira-mcp"] } } }));
    const d = await discoverMcpServers({ home, repo });
    expect(d.servers).toEqual([{ name: "jira", toolPrefix: "mcp__jira", origin: "repo", originDetail: repo }]);
  });

  it("returns account connectors as ordinary, usable entries", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Atlassian"] });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toEqual([
      { name: "claude.ai Atlassian", toolPrefix: "mcp__claude_ai_Atlassian", origin: "account" },
    ]);
  });

  it("returns one list across every source, each carrying where it came from", async () => {
    const home = await fakeHome({
      mcpServers: { local: { type: "http", url: "https://example.invalid" } },
      projects: { "/Users/x/repo": { mcpServers: { proj: { command: "npx" } } } },
      claudeAiMcpEverConnected: ["claude.ai Atlassian"],
    });
    const d = await discoverMcpServers({ home });
    expect(d.servers.map(s => [s.name, s.origin])).toEqual(
      expect.arrayContaining([["local", "user"], ["proj", "project"], ["claude.ai Atlassian", "account"]]),
    );
  });

  it("never returns a definition, so a credential cannot escape the scanner", async () => {
    const home = await fakeHome({
      mcpServers: { x: { type: "http", url: "https://e.invalid", headers: { Authorization: "Bearer hunter2" } } },
    });
    const d = await discoverMcpServers({ home });
    expect(JSON.stringify(d)).not.toContain("hunter2");
    expect(JSON.stringify(d)).not.toContain("Authorization");
    expect(d.servers[0]).toEqual({ name: "x", toolPrefix: "mcp__x", origin: "user" });
  });

  it("ignores a non-string entry in the account list", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Atlassian", 42, null] });
    const d = await discoverMcpServers({ home });
    expect(d.servers.map(s => s.name)).toEqual(["claude.ai Atlassian"]);
  });

  it("a locally defined server of the same name overrides the account connector", async () => {
    const home = await fakeHome({
      mcpServers: { "claude.ai Atlassian": { type: "http", url: "https://local-override" } },
      claudeAiMcpEverConnected: ["claude.ai Atlassian"],
    });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toHaveLength(1);
    expect(d.servers[0]!.origin).toBe("user");   // the local definition wins, not "account"
  });

  it("a malformed file is reported by name and does not blank the good ones", async () => {
    const home = await fakeHome("{ this is not json", { mcpServers: { ok: { type: "http", url: "https://example.invalid" } } });
    const d = await discoverMcpServers({ home });
    expect(d.servers.map(s => s.name)).toEqual(["ok"]);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatch(/\.claude\.json/);
  });

  // I4: V8's JSON.parse error can embed a source excerpt of the file it failed to parse — and
  // this is Claude Code's own MCP config, which can carry a bearer token in a server's headers.
  // That excerpt must never reach `discovery.problems`, which the Settings screen renders verbatim.
  it("a malformed file's parse error never echoes a credential from its own contents", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-mcp-secret-"));
    await writeFile(path.join(home, ".claude.json"),
      '{"mcpServers":{"x":{"headers":{"Authorization":Bearer sk-SECRET123}}}}');
    const d = await discoverMcpServers({ home });
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).not.toContain("sk-SECRET123");
    expect(d.problems[0]).not.toContain("Authorization");
    expect(d.problems[0]).not.toContain("Bearer");
    expect(d.problems[0]).toMatch(/\.claude\.json/);
  });

  it("a missing ~/.claude is nothing found, not an error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-empty-"));
    await expect(discoverMcpServers({ home })).resolves.toEqual({ servers: [], problems: [] });
  });

  it("reports a file it was meant to read but could not, distinctly from one that is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-unreadable-"));
    await mkdir(path.join(home, ".claude.json"));      // a directory where the file should be
    const d = await discoverMcpServers({ home });
    expect(d.servers).toEqual([]);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatch(/\.claude\.json/);
    expect(d.problems[0]).toMatch(/could not be read/);
  });

  it("prefers the more specific scope when the same name appears twice", async () => {
    const home = await fakeHome({
      mcpServers: { atlassian: { type: "http", url: "https://user-scope" } },
      projects: { "/Users/x/repo": { mcpServers: { atlassian: { type: "http", url: "https://project-scope" } } } },
    });
    const d = await discoverMcpServers({ home });
    expect(d.servers).toHaveLength(1);
    expect(d.servers[0]!.origin).toBe("project");
  });
});
