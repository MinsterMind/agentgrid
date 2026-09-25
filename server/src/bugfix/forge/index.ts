import { execFile } from "node:child_process";
import type { ForgeConfig } from "../integrations.js";
import { githubAdapter } from "./github.js";
import type { ForgeAdapter, Runner } from "./types.js";

export type { ForgeAdapter, CreatePrContext, Runner } from "./types.js";

const defaultRun: Runner = (cmd, args, cwd) => new Promise(res =>
  execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout) =>
    res({ stdout: String(stdout), code: err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0 })));

/** null means "no pollable forge configured" — the flow still runs, the PR is just tracked by hand. */
export function makeForge(cfg: ForgeConfig | undefined, run: Runner = defaultRun): ForgeAdapter | null {
  if (cfg?.preset === "github") return githubAdapter(run);
  return null;   // gitlab + custom land in Phase 2
}
