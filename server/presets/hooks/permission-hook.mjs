#!/usr/bin/env node
// AgentGrid's PermissionRequest hook. Asks the AgentGrid server that launched this session, and waits.
// It never decides on its own: on any failure it prints nothing and exits 0, and Claude Code asks in the terminal.
import http from "node:http";
const done = () => process.exit(0);
try {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const base = process.env.AGENTGRID_URL, token = process.env.AGENTGRID_HOOK_TOKEN;
  if (!base || !token) done();
  const url = new URL("/api/hooks/permission", base);
  const payload = JSON.stringify(input);
  const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } }, res => {
    let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c));
    res.on("end", () => {
      try {
        const decision = res.statusCode === 200 ? JSON.parse(b).decision : null;
        if (decision && (decision.behavior === "allow" || decision.behavior === "deny")) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
      } catch { /* no decision */ }
      done();
    });
  });
  req.on("error", done);
  req.end(payload);
} catch { done(); }
