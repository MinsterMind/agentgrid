import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, stat } from "node:fs/promises";
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

  it("lists memory files with frontmatter", async () => {
    const a = await store.createAgent({ role: "coder", repo: "/x/y" });
    await writeFile(path.join(store.memoryDir(a.id), "MEMORY.md"), "- [x](x.md)");
    await writeFile(path.join(store.memoryDir(a.id), "x.md"), "---\nname: x-fact\ndescription: a fact\n---\nbody");
    expect(await store.listMemory(a.id)).toEqual([{ file: "x.md", name: "x-fact", description: "a fact" }]);
  });
});
