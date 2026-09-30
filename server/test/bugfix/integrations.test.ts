import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
    expect(detectForge("https://bitbucket.org/acme/pay")).toBe("bitbucket");
    expect(detectForge(null)).toBeNull();
  });

  it("does not mistake lookalike hosts for gitlab, and accepts self-hosted gitlab", () => {
    expect(detectForge("https://gitlab-mirror.example.com/a/b")).toBeNull();
    expect(detectForge("https://notgitlab.io/a/b")).toBeNull();
    expect(detectForge("git@gitlab.example.com:a/b.git")).toBe("gitlab");
    expect(detectForge("https://gitlab.com/a/b")).toBe("gitlab");
  });

  it("detects bitbucket.org, and keeps github and gitlab as they were", () => {
    expect(detectForge("git@bitbucket.org:acme/payments.git")).toBe("bitbucket");
    expect(detectForge("https://bitbucket.org/acme/payments")).toBe("bitbucket");
    expect(detectForge("git@github.com:acme/app.git")).toBe("github");
    expect(detectForge("https://gitlab.com/acme/app")).toBe("gitlab");
    expect(detectForge("git@example.com:acme/app.git")).toBeNull();
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

  // A corrupt file used to read as an empty config, so a server booted with the tracker and forge
  // silently missing and the project->repo memory silently empty, with nothing anywhere saying
  // why. `readForWrite` already refused to swallow it; reading follows suit.
  it("says a corrupt file is corrupt rather than reading as an empty config", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(home, "integrations.json"), "{ not json");
    await expect(store.read()).rejects.toThrow(/corrupt/i);
    await expect(store.read()).rejects.toThrow(path.join(home, "integrations.json"));
  });

  it("still reads a missing file as empty — there is nothing to lose there", async () => {
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

  // I6: a present-but-unreadable file must never be reported the same as a missing one — the
  // "config-file" check would otherwise say "does not exist yet. Saving here creates it." for a
  // file that very much exists, and Saving would then overwrite it. `mkdir` at the file's own
  // path stands in for "present but this process can't read it" (EISDIR), same trick
  // mcp-discovery.test.ts uses for the same reason.
  it("says an unreadable file is broken, not missing", async () => {
    const file = path.join(home, "integrations.json");
    await mkdir(file);
    await expect(store.read()).rejects.toThrow(/could not be read/i);
    await expect(store.exists()).rejects.toThrow(/could not be read/i);
  });

  // I4: the JSON.parse error can embed a source excerpt straight out of the file it failed to
  // parse — and this file stores tracker/forge credentials. Never let that excerpt reach the
  // thrown message.
  it("never echoes a credential from a corrupt file's own contents in the parse error", async () => {
    const file = path.join(home, "integrations.json");
    await writeFile(file, '{"tracker":{"mcpServers":{"x":{"headers":{"Authorization":Bearer sk-SECRET123}}}}}');
    const err = await store.read().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/corrupt/i);
    expect((err as Error).message).not.toContain("sk-SECRET123");
    expect((err as Error).message).not.toContain("Authorization");
    expect((err as Error).message).not.toContain("Bearer");
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
