import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";

const live = process.env.AGENTGRID_LIVE === "1";
const until = async (pred: () => boolean, ms = 120_000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 200)); } };

describe.skipIf(!live)("live SDK", () => {
  it("permission + question + memory + resume", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-live-"));
    const repo = await mkdtemp(path.join(tmpdir(), "ag-repo-")); await writeFile(path.join(repo, "README.md"), "# t");
    const store = new Store(home, path.resolve("roles")); await store.init();
    await writeFile(path.join(home, "roles", "spike.md"), `---\nname: spike\nmodel: claude-opus-5\neffort: low\npermissionMode: default\nsettingSources: []\nmaxTurns: 10\n---\nYou are a test agent. Follow instructions literally.`);
    await store.reloadRoles();
    const agent = await store.createAgent({ role: "spike", repo });
    const mgr = new Manager(store);
    const asg = await mgr.assign(agent.id, `1. Call AskUserQuestion with one question "Which greeting?" options "hello" and "namaste".\n2. Using Bash run: echo "<answer>" > greeting.txt\n3. Save a memory file about which greeting this repo uses.\n4. Reply: DONE <greeting>.`);

    await until(() => store.getAssignment(asg.id).pending?.kind === "question");
    const q = store.getAssignment(asg.id).pending!;
    await mgr.answer(agent.id, q.toolUseId, { kind: "answers", answers: { [(q.input as any).questions[0].question]: "namaste" } });
    await until(() => store.getAssignment(asg.id).pending?.kind === "permission");
    await mgr.answer(agent.id, store.getAssignment(asg.id).pending!.toolUseId, { kind: "allow" });
    // memory write may also prompt (Write tool) — allow anything further
    await until(() => { const a = store.getAssignment(asg.id); if (a.pending) void mgr.answer(agent.id, a.pending.toolUseId, { kind: "allow" }); return a.state === "done" || a.state === "failed"; });

    const done = store.getAssignment(asg.id);
    expect(done.state).toBe("done");
    expect(done.outcome).toMatch(/namaste/i);
    expect(await readFile(path.join(repo, "greeting.txt"), "utf8")).toMatch(/namaste/);
    expect((await readdir(store.memoryDir(agent.id))).some(f => f.endsWith(".md"))).toBe(true);

    const reply = await new Promise<string>((res, rej) => execFile("claude", ["--resume", done.sessionId!, "-p", "One line: what greeting did you write?"], { cwd: repo }, (e, out) => (e ? rej(e) : res(out))));
    expect(reply).toMatch(/namaste/i);
  }, 300_000);
});
