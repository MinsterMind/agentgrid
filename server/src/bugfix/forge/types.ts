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
  isSelf: boolean;          // the forge's own account — the user, never a reviewer (spec 2026-10-09 §5)
  body: string;
  at: string;               // ISO
}
export interface MergeResult { ok: boolean; message: string }

/** What the workflow needs from a code-review forge. Phase 2 adds getPr/listReviewEvents/merge. */
export interface ForgeAdapter {
  readonly name: string;
  authStatus(): Promise<{ ok: boolean; message: string }>;
  /**
   * Create the pull request. Server work: no agent ever holds a forge credential.
   * Never throws — `{unavailable}` carries the forge's own message. When the forge
   * refuses because a PR already exists for this branch, adopt that PR rather than
   * failing: a retried `creating-pr` must be idempotent.
   */
  createPr(repoDir: string, ctx: CreatePrContext): Promise<PrLookup>;
  /** The server's own check that the PR exists — never trust the agent's claim. */
  findPr(repoDir: string, branch: string): Promise<PrInfo | null>;
  /** By number — what the watcher ticks on. Never throws. */
  getPr(repoDir: string, number: number): Promise<PrLookup>;
  /** Events strictly after `since`, oldest first. Never throws; returns [] when unreadable. */
  listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]>;
  merge(repoDir: string, number: number, method: MergeMethod): Promise<MergeResult>;
  /** Every open AgentGrid PR in the repo, in as few calls as the forge allows — what lets ~1000 PRs be
   *  watched within API limits (spec 2026-10-07 §6). Optional: without it the watcher polls per PR.
   *  `all`: every open PR in the repo, with branch, base and title — what an import matches tickets against (spec 2026-10-09 §3.4). */
  listOpenPrs?(repoDir: string, opts?: { all?: boolean }): Promise<{ prs: PrInfo[] } | { unavailable: string }>;
  /** The newest merged PR whose title or head branch names `key`; null when none or unreadable. */
  findMergedPr?(repoDir: string, key: string): Promise<PrInfo | null>;
  /** The account the forge CLI or token acts as — whose comments are the user's own. Cached once known. */
  whoami?(repoDir: string): Promise<{ login: string } | { unavailable: string }>;
}

export type Runner = (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string; stderr?: string; code: number }>;
export type { PrInfo };
