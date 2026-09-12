import { describe, it, expect } from "vitest";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { Manager } from "../src/runner/manager.js";
import { createApp } from "../src/api/app.js";
import { makeFakeQuery } from "./helpers/fakeQuery.js";

describe("SSE", () => {
  it("sends a snapshot then change events", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ag-"));
    const store = new Store(home, path.resolve("roles")); await store.init();
    const app = createApp({ store, manager: new Manager(store, { queryFn: makeFakeQuery().queryFn }) });
    const server = http.createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;

    const chunks: string[] = [];
    const res = await new Promise<http.IncomingMessage>(r => http.get(`http://127.0.0.1:${port}/api/events`, r));
    expect(res.headers["content-type"]).toContain("text/event-stream");
    res.setEncoding("utf8"); res.on("data", c => chunks.push(c));

    await new Promise(r => setTimeout(r, 30));
    await store.createAgent({ role: "coder", repo: "/x/hrns" });
    await new Promise(r => setTimeout(r, 30));

    const text = chunks.join("");
    expect(text).toMatch(/^event: snapshot\ndata: \{"roles"/);
    expect(text).toContain('event: change\ndata: {"type":"agent","agent":{"id":"coder@hrns"');
    res.destroy(); server.close();
  });
});
