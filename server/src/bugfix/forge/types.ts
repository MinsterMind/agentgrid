import type { PrInfo } from "../types.js";

export interface CreatePrContext { title: string; bodyFile: string; base: string; head: string }

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Three states, not two. Phase 1's `findPr` returned `null` both for "no PR" and for
 * "`gh` failed", which was survivable only because the PR stage was human-gated. The
 * watcher polls unattended, so a flaky CLI must never read as "the PR vanished".
 */
export type PrLookup = { found: PrInfo } | { found: null } | { unavailable: string };

export interface ReviewEvent {
  kind: "review" | "comment" | "check";
  state: string;            // e.g. "CHANGES_REQUESTED", "APPROVED", "" for a plain comment
  author: string;
  isBot: boolean;           // the adapter decides; the engine must never guess from a name
  body: string;
  at: string;               // ISO
}
export interface MergeResult { ok: boolean; message: string }

/** What the workflow needs from a code-review forge. Phase 2 adds getPr/listReviewEvents/merge. */
export interface ForgeAdapter {
  readonly name: string;
  authStatus(): Promise<{ ok: boolean; message: string }>;
  /** Command string handed to the agent during `opening-pr`. */
  createPrCommand(ctx: CreatePrContext): string;
  /** The server's own check that the PR exists — never trust the agent's claim. */
  findPr(repoDir: string, branch: string): Promise<PrInfo | null>;
  /** By number — what the watcher ticks on. Never throws. */
  getPr(repoDir: string, number: number): Promise<PrLookup>;
  /** Events strictly after `since`, oldest first. Never throws; returns [] when unreadable. */
  listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]>;
  merge(repoDir: string, number: number, method: MergeMethod): Promise<MergeResult>;
}

export type Runner = (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr?: string; code: number }>;
export type { PrInfo };
