import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, NotFound } from "../src/store/store.js";
import type { GridEvent } from "../src/types.js";

let home: string; let store: Store; let events: GridEvent[];
const defaults = path.resolve("roles");

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "ag-"));
  store = new Store(home, defaults);
  events = [];
  store.on("event", e => events.push(e));
  await store.init();
});

describe("Store agents", () => {
  it("loads default roles on init", () => {
    expect(store.listRoles().map(r => r.name)).toContain("coder");
    expect(() => store.getRole("nope")).toThrow(NotFound);
  });

  it("creates an agent with derived id and default name, persists it, emits", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/tmp/proj/hrns" });
    expect(a.id).toBe("coder@hrns");
    expect(a.state).toBe("free");
    expect(a.displayName).toBeTruthy();
    const onDisk = JSON.parse(await readFile(path.join(home, "agents", "coder@hrns.json"), "utf8"));
    expect(onDisk).toEqual(a);
    expect((await stat(path.join(home, "agents", "coder@hrns", "memory"))).isDirectory()).toBe(true);
    expect(events).toEqual([{ type: "agent", agent: a }]);
  });

  it("suffixes ids on collision", async () => {
    await store.createAgent({ role: "coder", repo: "/a/hrns" });
    const b = await store.createAgent({ role: "coder", repo: "/b/hrns" });
    const c = await store.createAgent({ role: "coder", repo: "/c/hrns" });
    expect(b.id).toBe("coder@hrns-2");
    expect(c.id).toBe("coder@hrns-3");
  });

  it("rejects unknown role", async () => {
    await expect(store.createAgent({ role: "ghost", repo: "/x" })).rejects.toThrow(NotFound);
  });

  it("updates and reloads from disk", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await store.updateAgent(a.id, { state: "working", currentAssignmentId: "a1" });
    const s2 = new Store(home, defaults); await s2.init();
    expect(s2.getAgent(a.id)).toMatchObject({ state: "working", currentAssignmentId: "a1" });
  });

  it("archives: moves dir, removes json, emits removal", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await writeFile(path.join(store.memoryDir(a.id), "MEMORY.md"), "- x");
    await store.archiveAgent(a.id);
    expect(() => store.getAgent(a.id)).toThrow(NotFound);
    expect((await stat(path.join(home, "agents", "_archived", a.id, "memory", "MEMORY.md"))).isFile()).toBe(true);
    expect(events.at(-1)).toEqual({ type: "agent-removed", id: a.id });
  });

  it("archives, then re-creates and re-archives the same id without clobbering the earlier archive", async () => {
    const a1 = await store.createAgent({ role: "coder", repo: "/x/hrns" });
    await writeFile(path.join(store.memoryDir(a1.id), "MEMORY.md"), "- first");
    await store.archiveAgent(a1.id);

    const a2 = await store.createAgent({ role: "coder", repo: "/x/hrns" });
    expect(a2.id).toBe(a1.id); // id freed up by the archive, reused
    await writeFile(path.join(store.memoryDir(a2.id), "MEMORY.md"), "- second");
    await expect(store.archiveAgent(a2.id)).resolves.toBeUndefined();

    const archivedEntries = await readdir(path.join(home, "agents", "_archived"));
    expect(archivedEntries.length).toBe(2);
    const first = await readFile(path.join(home, "agents", "_archived", a1.id, "memory", "MEMORY.md"), "utf8");
    expect(first).toBe("- first");
    const secondDir = archivedEntries.find(e => e !== a1.id)!;
    const second = await readFile(path.join(home, "agents", "_archived", secondDir, "memory", "MEMORY.md"), "utf8");
    expect(second).toBe("- second");
  });

  it("lists memory files with frontmatter", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await writeFile(path.join(store.memoryDir(a.id), "MEMORY.md"), "- [x](x.md)");
    await writeFile(path.join(store.memoryDir(a.id), "x.md"), "---\nname: x-fact\ndescription: a fact\n---\nbody");
    expect(await store.listMemory(a.id)).toEqual([{ file: "x.md", name: "x-fact", description: "a fact" }]);
  });
});

describe("Store assignments", () => {
  it("creates with sequential ids, working state, and emits", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    const s1 = await store.createAssignment({ agentId: a.id, prompt: "do x" });
    const s2 = await store.createAssignment({ agentId: a.id, prompt: "do y" });
    expect([s1.id, s2.id]).toEqual(["a1", "a2"]);
    expect(s1).toMatchObject({ state: "working", pending: null, costUsd: 0, turns: 0, sessionId: null });
    expect(events.filter(e => e.type === "assignment")).toHaveLength(2);
  });

  it("continues the id counter after restart", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await store.createAssignment({ agentId: a.id, prompt: "p" });
    const s2 = new Store(home, defaults); await s2.init();
    const next = await s2.createAssignment({ agentId: a.id, prompt: "q" });
    expect(next.id).toBe("a2");
  });

  it("lists active first, then most recent finished up to limit", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    const s1 = await store.createAssignment({ agentId: a.id, prompt: "1" });
    const s2 = await store.createAssignment({ agentId: a.id, prompt: "2" });
    const s3 = await store.createAssignment({ agentId: a.id, prompt: "3" });
    await store.updateAssignment(s1.id, { state: "done" });
    await store.updateAssignment(s2.id, { state: "failed" });
    const list = store.listAssignments(1);
    expect(list.map(x => x.id)).toEqual([s3.id, s2.id]);
  });

  it("rejects unknown agent / assignment", async () => {
    await expect(store.createAssignment({ agentId: "nope", prompt: "p" })).rejects.toThrow(NotFound);
    expect(() => store.getAssignment("a99")).toThrow(NotFound);
  });

  it("survives 20 concurrent updateAssignment calls without temp-file collisions", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    const s = await store.createAssignment({ agentId: a.id, prompt: "p" });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.updateAssignment(s.id, { turns: i + 1 }))
    );
    const onDisk = JSON.parse(await readFile(path.join(home, "assignments", `${s.id}.json`), "utf8"));
    expect(onDisk).toEqual(store.getAssignment(s.id));
  });
});
