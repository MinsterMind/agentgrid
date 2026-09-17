#!/usr/bin/env node
import { startServer } from "./start.js";

const cmd = process.argv[2];
if (cmd === "serve") {
  startServer().then(running => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void running.close().then(() => process.exit(0)); });
  }).catch((err: NodeJS.ErrnoException) => {
    // A bind failure (most commonly EADDRINUSE) should read plainly, not as a stack trace.
    if (err.code === "EADDRINUSE") console.error(`port ${process.env.AGENTGRID_PORT ?? 4800} already in use — set AGENTGRID_PORT to another port`);
    else console.error(err.message ?? err);
    process.exit(1);
  });
} else { console.log("usage: agentgrid serve"); process.exit(cmd ? 1 : 0); }
