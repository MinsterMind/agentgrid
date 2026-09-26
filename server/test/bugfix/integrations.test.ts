import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntegrationsStore, detectForge } from "../../src/bugfix/integrations.js";

let home: string; let store: IntegrationsStore;
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), "int-")); store = new IntegrationsStore(home); });

describe("detectForge", () => {
  it("recognises github and gitlab remotes in both URL forms, and nothing else", () => {
    expect(detectForge("git@github.com:acme/pay.git")).toBe("github");
    expect(detectForge("https://github.com/acme/pay")).toBe("github");
    expect(detectForge("git@gitlab.com:acme/pay.git")).toBe("gitlab");
    expect(detectForge("https://gitlab.example.com/acme/pay.git")).toBe("gitlab");
    expect(detectForge("https://bitbucket.org/acme/pay")).toBeNull();
    expect(detectForge(null)).toBeNull();
  });

  it("does not mistake lookalike hosts for gitlab, and accepts self-hosted gitlab", () => {
    expect(detectForge("https://gitlab-mirror.example.com/a/b")).toBeNull();
    expect(detectForge("https://notgitlab.io/a/b")).toBeNull();
    expect(detectForge("git@gitlab.example.com:a/b.git")).toBe("gitlab");
    expect(detectForge("https://gitlab.com/a/b")).toBe("gitlab");
  });
});

describe("IntegrationsStore", () => {
  it("starts empty, merges patches, and round-trips through disk", async () => {
    expect(await store.read()).toEqual({ projectRepos: {} });
    await store.write({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } } });
    await store.write({ forge: { preset: "github" } });
    const again = new IntegrationsStore(home);
    expect(await again.read()).toEqual({
      projectRepos: {},
      tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: { atlassian: { type: "sse", url: "https://mcp.atlassian.com/v1/sse" } } },
      forge: { preset: "github" },
    });
  });

  it("remembers the repo used per tracker project", async () => {
    expect(await store.repoFor("PAY")).toBeUndefined();
    await store.rememberRepo("PAY", "/r/payments");
    await store.rememberRepo("WEB", "/r/web");
    expect(await store.repoFor("PAY")).toBe("/r/payments");
    await store.rememberRepo("PAY", "/r/payments-v2");
    expect(await store.repoFor("PAY")).toBe("/r/payments-v2");
  });

  it("survives a corrupt file rather than throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "integrations.json"), "{ not json");
    expect(await store.read()).toEqual({ projectRepos: {} });
  });

  it("refuses to write onto a corrupt file rather than silently destroying it", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const file = path.join(home, "integrations.json");
    await writeFile(file, "{ not json");
    await expect(store.write({ forge: { preset: "github" } })).rejects.toThrow(/corrupt/i);
    // The file on disk must be untouched — not overwritten with just the new patch.
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("keeps both patches when two writes race", async () => {
    await Promise.all([
      store.write({ tracker: { preset: "jira", toolPrefix: "mcp__atlassian", mcpServers: {} } }),
      store.rememberRepo("PAY", "/r/payments"),
    ]);
    const after = await store.read();
    expect(after.tracker?.preset).toBe("jira");
    expect(after.projectRepos.PAY).toBe("/r/payments");
  });
});
