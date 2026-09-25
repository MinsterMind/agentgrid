import type { PrInfo } from "../types.js";

export interface CreatePrContext { title: string; bodyFile: string; base: string; head: string }

/** What the workflow needs from a code-review forge. Phase 2 adds getPr/listReviewEvents/merge. */
export interface ForgeAdapter {
  readonly name: string;
  authStatus(): Promise<{ ok: boolean; message: string }>;
  /** Command string handed to the agent during `opening-pr`. */
  createPrCommand(ctx: CreatePrContext): string;
  /** The server's own check that the PR exists — never trust the agent's claim. */
  findPr(repoDir: string, branch: string): Promise<PrInfo | null>;
}

export type Runner = (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string; code: number }>;
export type { PrInfo };
