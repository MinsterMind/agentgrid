import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverMcpServers } from "../../src/bugfix/mcp-discovery.js";

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

describe("discoverMcpServers", () => {
  it("finds user-scoped servers with their definitions", async () => {
    const home = await fakeHome({ mcpServers: { atlassian: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([{ name: "atlassian", definition: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, origin: "user" }]);
    expect(d.accountOnly).toEqual([]);
    expect(d.problems).toEqual([]);
  });

  it("finds project-scoped servers and records which project they came from", async () => {
    const home = await fakeHome({ projects: { "/Users/x/repo": { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app" } } } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([{ name: "linear", definition: { type: "http", url: "https://mcp.linear.app" }, origin: "project", originDetail: "/Users/x/repo" }]);
  });

  it("finds a repo's .mcp.json when a repo is given", async () => {
    const home = await fakeHome({});
    const repo = await mkdtemp(path.join(os.tmpdir(), "agentgrid-repo-"));
    await writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "npx", args: ["-y", "jira-mcp"] } } }));
    const d = await discoverMcpServers({ home, repo });
    expect(d.importable).toEqual([{ name: "jira", definition: { command: "npx", args: ["-y", "jira-mcp"] }, origin: "repo", originDetail: repo }]);
  });

  it("reports account-level connectors by name, never as importable", async () => {
    const home = await fakeHome({ claudeAiMcpEverConnected: ["claude.ai Claude Docs", "claude.ai Kite mcp"] });
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([]);
    expect(d.accountOnly).toEqual(["claude.ai Claude Docs", "claude.ai Kite mcp"]);
  });

  it("a malformed file is reported by name and does not blank the good ones", async () => {
    const home = await fakeHome("{ this is not json", { mcpServers: { ok: { type: "http", url: "https://example.invalid" } } });
    const d = await discoverMcpServers({ home });
    expect(d.importable.map(s => s.name)).toEqual(["ok"]);
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0]).toMatch(/\.claude\.json/);
  });

  it("a missing ~/.claude is nothing found, not an error", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-empty-"));
    await expect(discoverMcpServers({ home })).resolves.toEqual({ importable: [], accountOnly: [], problems: [] });
  });

  it("reports a file it was meant to read but could not, distinctly from one that is absent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentgrid-unreadable-"));
    await mkdir(path.join(home, ".claude.json"));      // a directory where the file should be
    const d = await discoverMcpServers({ home });
    expect(d.importable).toEqual([]);
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
    expect(d.importable).toHaveLength(1);
    expect(d.importable[0]!.definition).toEqual({ type: "http", url: "https://project-scope" });
    expect(d.importable[0]!.origin).toBe("project");
  });
});
