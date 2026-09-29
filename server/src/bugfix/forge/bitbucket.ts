import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatePrContext, ForgeAdapter, MergeMethod, PrLookup, ReviewEvent } from "./types.js";
import type { PrInfo } from "../types.js";

const run = promisify(execFile);
const API = "https://api.bitbucket.org/2.0";

export interface BitbucketDeps {
  username: string;                       // the Atlassian email, from ForgeConfig
  token?: () => string | undefined;       // defaults to () => process.env.BITBUCKET_API_TOKEN
  fetchFn?: typeof fetch;                 // injected in tests
  /** The repo's `origin` remote URL, or null when it can't be read. Defaults to
   *  `git -C <repoDir> remote get-url origin`. Injected in tests so the slug-resolution path
   *  can be exercised without a real git checkout. */
  gitRemoteUrl?: (repoDir: string) => Promise<string | null>;
}

/** `git@bitbucket.org:ws/slug.git`, `https://user@bitbucket.org/ws/slug.git`, `ssh://git@bitbucket.org/ws/slug`. */
export function parseRepoSlug(remoteUrl: string): { workspace: string; slug: string } | null {
  // Host-anchored: `(?<![\w.-])` refuses a match where "bitbucket.org" is merely a substring
  // of a longer label (e.g. `evilbitbucket.org:acme/payments.git`), which would otherwise
  // parse as a valid slug.
  const m = /(?<![\w.-])bitbucket\.org[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  return m ? { workspace: m[1], slug: m[2] } : null;
}

/** Every request's outcome, mapped once so every method agrees on what a status code means. */
type ApiResult =
  | { kind: "no-token" }
  | { kind: "refused" }
  | { kind: "missing" }
  | { kind: "unavailable"; message: string }
  | { kind: "ok"; body: any };

const FAILURE_STATES = ["FAILED", "STOPPED"];
const SUCCESS_STATES = ["SUCCESSFUL"];

/** Roll many Bitbucket commit-status outcomes into one: any failure wins, else any pending, else success. */
function rollupChecks(statuses: Array<{ state?: string }> | undefined): string | null {
  if (!statuses?.length) return null;
  const states = statuses.map(s => (s.state ?? "").toUpperCase());
  if (states.some(s => FAILURE_STATES.includes(s))) return "FAILURE";
  if (states.some(s => !SUCCESS_STATES.includes(s))) return "PENDING";
  return "SUCCESS";
}

/**
 * Bitbucket has no `reviewDecision`: it has per-reviewer state on `participants`. Fold it
 * with one rule — ANY outstanding "changes requested" outranks ANY number of approvals.
 * The alternative is merging over an unresolved objection, which is the one direction that
 * cannot be walked back.
 */
function reviewDecision(pr: any): string | null {
  const parts: any[] = Array.isArray(pr?.participants) ? pr.participants : [];
  if (parts.some(p => String(p?.state ?? "").toLowerCase() === "changes_requested")) return "CHANGES_REQUESTED";
  if (parts.some(p => p?.approved === true)) return "APPROVED";
  return null;
}

function toPrInfo(pr: any, checks: string | null): PrInfo {
  const state = (pr.state ?? "").toUpperCase();
  const normalisedState: PrInfo["state"] =
    state === "MERGED" ? "MERGED" : state === "DECLINED" || state === "SUPERSEDED" ? "CLOSED" : "OPEN";
  return {
    number: pr.id,
    url: pr.links?.html?.href ?? "",
    state: normalisedState,
    reviewDecision: reviewDecision(pr),
    checks,
    mergeable: null,        // Task 6
    headSha: pr.source?.commit?.hash ?? null,
    lastSeenEventAt: pr.updated_on ?? new Date().toISOString(),
  };
}

function looksLikePr(pr: any): boolean {
  return typeof pr === "object" && pr !== null && !Array.isArray(pr) && typeof pr.id === "number";
}

const defaultGitRemoteUrl = async (repoDir: string): Promise<string | null> => {
  try {
    const { stdout } = await run("git", ["-C", repoDir, "remote", "get-url", "origin"]);
    return stdout.trim();
  } catch {
    return null;
  }
};

export function bitbucketAdapter(deps: BitbucketDeps): ForgeAdapter {
  const getToken = deps.token ?? (() => process.env.BITBUCKET_API_TOKEN);
  const doFetch = deps.fetchFn ?? fetch;
  const getRemoteUrl = deps.gitRemoteUrl ?? defaultGitRemoteUrl;

  async function api(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<ApiResult> {
    const token = getToken();
    if (!token) return { kind: "no-token" };
    const auth = `Basic ${Buffer.from(`${deps.username}:${token}`).toString("base64")}`;
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method: init?.method ?? "GET",
        body: init?.body,
        headers: { authorization: auth, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
      });
    } catch (err) {
      return { kind: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 401 || res.status === 403) return { kind: "refused" };
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 429 || res.status >= 500) {
      return { kind: "unavailable", message: `Bitbucket returned ${res.status}${res.status === 429 ? " (rate limited)" : ""}` };
    }
    let body: any;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return { kind: "unavailable", message: `could not read Bitbucket's response (status ${res.status})` };
    }
    return { kind: "ok", body };
  }

  /**
   * Resolve workspace/slug from the repo's `origin` remote — once per call, cached nowhere
   * (a task's repo does not change mid-run, but caching across tasks would be a bug waiting
   * for a second repo). Returns null, never throws, when the remote can't be read or doesn't
   * look like a bitbucket.org URL — the caller must treat that as "we don't know", not as
   * grounds for an API call with an empty workspace/slug (which Bitbucket would 404, and a
   * 404 means something specific: the forge positively reports the PR is absent).
   */
  async function resolveSlug(repoDir: string): Promise<{ workspace: string; slug: string } | null> {
    const url = await getRemoteUrl(repoDir);
    if (!url) return null;
    return parseRepoSlug(url);
  }

  /** The check rollup for one PR, from its commit-status endpoint. Never throws; unreadable reads as null (unknown), not success. */
  async function fetchChecks(workspace: string, slug: string, number: number): Promise<string | null> {
    const r = await api(`/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pullrequests/${number}/statuses`);
    if (r.kind !== "ok") return null;
    const values = Array.isArray(r.body?.values) ? r.body.values : [];
    return rollupChecks(values);
  }

  async function lookupByNumber(repoDir: string, number: number): Promise<PrLookup> {
    const slug = await resolveSlug(repoDir);
    if (!slug) {
      return { unavailable: `could not determine the Bitbucket repository from ${repoDir}'s origin remote` };
    }
    const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests/${number}`);
    if (r.kind === "no-token") return { unavailable: "BITBUCKET_API_TOKEN is not set" };
    if (r.kind === "refused") return { unavailable: "Bitbucket refused the request (token not accepted)" };
    if (r.kind === "missing") return { found: null };
    if (r.kind === "unavailable") return { unavailable: r.message };
    if (!looksLikePr(r.body)) return { unavailable: `Bitbucket's response for PR #${number} did not look like a pull request` };
    const checks = await fetchChecks(slug.workspace, slug.slug, number);
    return { found: toPrInfo(r.body, checks) };
  }

  return {
    name: "bitbucket",

    async authStatus() {
      const token = getToken();
      if (!token) {
        return { ok: false, message: "BITBUCKET_API_TOKEN is not set in the server's environment. Export it and restart the server." };
      }
      // "no-token" can't recur here: `token` above is truthy, and `api()` only reports
      // "no-token" when the getter returns falsy. Asserted away rather than left as a
      // runtime branch that can never execute.
      const r = await api("/user") as Exclude<ApiResult, { kind: "no-token" }>;
      if (r.kind === "refused") return { ok: false, message: "Bitbucket refused the token (401/403) — it was not accepted." };
      if (r.kind === "missing") return { ok: false, message: "Bitbucket returned 404 for /user." };
      if (r.kind === "unavailable") return { ok: false, message: r.message };
      const who = r.body?.display_name ?? r.body?.nickname ?? deps.username;
      return { ok: true, message: `Authenticated to Bitbucket as ${who} (${deps.username}).` };
    },

    async createPr(_repoDir: string, _ctx: CreatePrContext): Promise<PrLookup> {
      return { unavailable: "createPr is not yet implemented for Bitbucket" };
    },

    async findPr(repoDir: string, branch: string): Promise<PrInfo | null> {
      const slug = await resolveSlug(repoDir);
      if (!slug) return null;
      const q = `source.branch.name="${branch}" AND state="OPEN"`;
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests?q=${encodeURIComponent(q)}`);
      if (r.kind !== "ok") return null;
      const values = Array.isArray(r.body?.values) ? r.body.values : [];
      const pr = values[0];
      if (!looksLikePr(pr)) return null;
      const checks = await fetchChecks(slug.workspace, slug.slug, pr.id);
      return toPrInfo(pr, checks);
    },

    async getPr(repoDir: string, number: number): Promise<PrLookup> {
      return lookupByNumber(repoDir, number);
    },

    async listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]> {
      const slug = await resolveSlug(repoDir);
      if (!slug) return [];
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests/${number}/activity`);
      if (r.kind !== "ok") return [];
      const values = Array.isArray(r.body?.values) ? r.body.values : [];
      const sinceMs = Date.parse(since);
      // Bitbucket reports no bot-account signal for pull-request participants today — `type`
      // is always "user" in the documented shape. Check it anyway so a future value ("bot")
      // is honoured rather than silently ignored; absent or unrecognised reads as false,
      // never true, because a falsely-human bot could start a round the engine shouldn't act on.
      const isBotAccount = (u: any): boolean => typeof u?.type === "string" && u.type.toLowerCase() === "bot";
      const out: ReviewEvent[] = [];
      for (const entry of values) {
        if (entry?.comment) {
          const c = entry.comment;
          out.push({ kind: "comment", state: "", author: c.user?.nickname ?? c.user?.display_name ?? "",
            isBot: isBotAccount(c.user), body: c.content?.raw ?? "", at: c.created_on ?? "" });
        } else if (entry?.changes_requested) {
          const cr = entry.changes_requested;
          out.push({ kind: "review", state: "CHANGES_REQUESTED", author: cr.user?.nickname ?? cr.user?.display_name ?? "",
            isBot: isBotAccount(cr.user), body: cr.content?.raw ?? "", at: cr.date ?? "" });
        } else if (entry?.approval) {
          const a = entry.approval;
          out.push({ kind: "review", state: "APPROVED", author: a.user?.nickname ?? a.user?.display_name ?? "",
            isBot: isBotAccount(a.user), body: a.content?.raw ?? "", at: a.date ?? "" });
        }
        // `update`, `merge` and anything else are not review events; dropped.
      }
      return out
        .filter(e => { const ms = Date.parse(e.at); return Number.isFinite(ms) && ms > sinceMs; })
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },

    async merge(_repoDir: string, _number: number, _method: MergeMethod) {
      return { ok: false, message: "merge is not yet implemented for Bitbucket" };
    },
  };
}
