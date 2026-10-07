import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  /** What SSH actually connects to for `host` — resolving a `~/.ssh/config` alias such as
   *  `bitbucket.org-work` the same way `git push` does. Defaults to `ssh -G <host>`; null when
   *  it can't be asked. Injected in tests so no unit test shells out to ssh. */
  sshHostname?: (host: string) => Promise<string | null>;
}

/** A git remote as host + path, from either form git accepts: a URL (`https://user@host/ws/slug.git`,
 *  `ssh://git@host:22/ws/slug`) or scp-like (`git@host:ws/slug.git`). Null for anything else. */
export function parseRemote(remoteUrl: string): { host: string; path: string; scpLike: boolean } | null {
  const u = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const url = new URL(u); return url.hostname ? { host: url.hostname.toLowerCase(), path: url.pathname, scpLike: false } : null; }
    catch { return null; }
  }
  // The host must start with a letter or digit: it is later passed to `ssh -G` as an argument,
  // and one beginning with "-" would be read as an option.
  const scp = /^(?:[^@/\s]+@)?([a-z0-9][^@:/\s]*):(?!\/\/)(.+)$/i.exec(u);
  return scp ? { host: scp[1].toLowerCase(), path: scp[2], scpLike: true } : null;
}

/** `ws/slug`, `/ws/slug.git/` → workspace + slug; anything with more or fewer segments → null. */
function slugFromPath(p: string): { workspace: string; slug: string } | null {
  const parts = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  return parts.length === 2 && parts[0] && parts[1] ? { workspace: parts[0], slug: parts[1] } : null;
}

/** `git@bitbucket.org:ws/slug.git`, `https://user@bitbucket.org/ws/slug.git/`, `ssh://git@bitbucket.org:22/ws/slug`.
 *  The host must BE bitbucket.org — not contain it — so `evilbitbucket.org` and
 *  `bitbucket.org.evil.com` are refused. SSH aliases are resolved by the adapter, not here. */
export function parseRepoSlug(remoteUrl: string): { workspace: string; slug: string } | null {
  const r = parseRemote(remoteUrl);
  return r && r.host === "bitbucket.org" ? slugFromPath(r.path) : null;
}

/** The `hostname` line of `ssh -G <host>` output. */
export function hostnameFromSshConfig(stdout: string): string | null {
  const m = /^hostname\s+(\S+)\s*$/im.exec(stdout);
  return m ? m[1].toLowerCase() : null;
}

/** A remote URL fit for an error message: a password in `https://user:pass@host` is dropped. */
export const redactRemote = (url: string) => url.replace(/(\/\/[^:@/]+):[^@/]*@/, "$1@");

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

function toPrInfo(pr: any, checks: string | null, mergeable: PrInfo["mergeable"]): PrInfo {
  const state = (pr.state ?? "").toUpperCase();
  const normalisedState: PrInfo["state"] =
    state === "MERGED" ? "MERGED" : state === "DECLINED" || state === "SUPERSEDED" ? "CLOSED" : "OPEN";
  return {
    number: pr.id,
    url: pr.links?.html?.href ?? "",
    state: normalisedState,
    reviewDecision: reviewDecision(pr),
    checks,
    mergeable,
    headSha: pr.source?.commit?.hash ?? null,
    lastSeenEventAt: pr.updated_on ?? new Date().toISOString(),
  };
}

function looksLikePr(pr: any): boolean {
  return typeof pr === "object" && pr !== null && !Array.isArray(pr) && typeof pr.id === "number";
}

const defaultSshHostname = async (host: string): Promise<string | null> => {
  try {
    const { stdout } = await run("ssh", ["-G", host], { timeout: 5_000 });
    return hostnameFromSshConfig(stdout);
  } catch {
    return null;
  }
};

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
  const getSshHostname = deps.sshHostname ?? defaultSshHostname;

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
   * for a second repo). Never throws: when the remote can't be read or doesn't lead to
   * bitbucket.org it returns why, in words the human can act on — the caller must treat that as
   * "we don't know", not as grounds for an API call with an empty workspace/slug (which
   * Bitbucket would 404, and a 404 means something specific: the forge positively reports the
   * PR is absent).
   */
  async function resolveRepo(repoDir: string): Promise<{ ok: true; workspace: string; slug: string } | { ok: false; reason: string }> {
    const why = (reason: string) => ({ ok: false as const, reason: `could not determine the Bitbucket repository: ${reason}` });
    const url = await getRemoteUrl(repoDir);
    if (!url) return why(`${repoDir} has no "origin" remote, or git could not read it`);
    const shown = redactRemote(url);
    const remote = parseRemote(url);
    if (!remote) return why(`the origin remote of ${repoDir} (${shown}) is not a git URL AgentGrid understands`);
    let host = remote.host;
    // An scp-like or ssh:// remote goes through ssh, so its host may be a ~/.ssh/config alias
    // (`bitbucket.org-work`) — ask ssh where it really leads, exactly as `git push` would.
    if (host !== "bitbucket.org" && (remote.scpLike || /^ssh:/i.test(url.trim()))) {
      const real = await getSshHostname(host);
      if (real === "bitbucket.org") host = real;
      else return why(`the origin remote of ${repoDir} (${shown}) points at ${remote.host}` +
        (real && real !== remote.host ? `, which your SSH config resolves to ${real}` : "") + `, not bitbucket.org`);
    }
    if (host !== "bitbucket.org") return why(`the origin remote of ${repoDir} (${shown}) points at ${host}, not bitbucket.org`);
    const slug = slugFromPath(remote.path);
    if (!slug) return why(`the origin remote of ${repoDir} (${shown}) does not end in <workspace>/<repository>`);
    return { ok: true, ...slug };
  }

  /** The check rollup for one PR, from its commit-status endpoint. Never throws; unreadable reads as null (unknown), not success. */
  async function fetchChecks(workspace: string, slug: string, number: number): Promise<string | null> {
    const r = await api(`/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pullrequests/${number}/statuses`);
    if (r.kind !== "ok") return null;
    const values = Array.isArray(r.body?.values) ? r.body.values : [];
    return rollupChecks(values);
  }

  /**
   * Bitbucket's PR object carries no `mergeable`. `/conflicts` answers it, but Atlassian has
   * said this area is changing (the diffstat "merge conflict" status is documented as going
   * away, with a new public API to follow), so the caller can pass a local fallback: the
   * server has the worktree and can answer with `git merge-tree` without any forge at all.
   * Unknown is `null` — never guess MERGEABLE, because that is the answer that skips a rebase.
   */
  async function fetchMergeable(workspace: string, slug: string, number: number): Promise<string | null> {
    const r = await api(`/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/pullrequests/${number}/conflicts`);
    if (r.kind !== "ok") return null;
    const values = Array.isArray(r.body?.values) ? r.body.values : null;
    if (values === null) return null;
    return values.length > 0 ? "CONFLICTING" : "MERGEABLE";
  }

  /**
   * The PR for `branch`: open first, then any state (spec §4.2), matching the GitHub
   * adapter's `findPrImpl` — a branch can have both an old closed PR and a current open
   * one, and the live one must win, but a closed/merged PR still needs to be found so a
   * retried `createPr` can adopt it. A hard failure on either query is never retried with
   * a second query — it degrades straight to null, same as every other findPr failure path.
   * Shared by `findPr` and by `createPr`'s duplicate-adoption path.
   */
  async function findPrByBranch(repoDir: string, branch: string): Promise<PrInfo | null> {
    const slug = await resolveRepo(repoDir);
    if (!slug.ok) return null;
    const query = async (state: "open" | "all"): Promise<{ ok: true; pr: any | null } | { ok: false }> => {
      const q = state === "open" ? `source.branch.name="${branch}" AND state="OPEN"` : `source.branch.name="${branch}"`;
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests?q=${encodeURIComponent(q)}`);
      if (r.kind !== "ok") return { ok: false };
      const values = Array.isArray(r.body?.values) ? r.body.values : [];
      return { ok: true, pr: values[0] ?? null };
    };
    const openResult = await query("open");
    if (!openResult.ok) return null;
    let pr = openResult.pr;
    if (!pr) {
      const allResult = await query("all");
      if (!allResult.ok) return null;
      pr = allResult.pr;
    }
    if (!looksLikePr(pr)) return null;
    const checks = await fetchChecks(slug.workspace, slug.slug, pr.id);
    const mergeable = await fetchMergeable(slug.workspace, slug.slug, pr.id);
    return toPrInfo(pr, checks, mergeable);
  }

  async function lookupByNumber(repoDir: string, number: number): Promise<PrLookup> {
    const slug = await resolveRepo(repoDir);
    if (!slug.ok) return { unavailable: slug.reason };
    const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests/${number}`);
    if (r.kind === "no-token") return { unavailable: "BITBUCKET_API_TOKEN is not set" };
    if (r.kind === "refused") return { unavailable: "Bitbucket refused the request (token not accepted)" };
    if (r.kind === "missing") return { found: null };
    if (r.kind === "unavailable") return { unavailable: r.message };
    if (!looksLikePr(r.body)) return { unavailable: `Bitbucket's response for PR #${number} did not look like a pull request` };
    const checks = await fetchChecks(slug.workspace, slug.slug, number);
    const mergeable = await fetchMergeable(slug.workspace, slug.slug, number);
    return { found: toPrInfo(r.body, checks, mergeable) };
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

    async createPr(repoDir: string, ctx: CreatePrContext): Promise<PrLookup> {
      const slug = await resolveRepo(repoDir);
      if (!slug.ok) return { unavailable: slug.reason };
      let description: string;
      try {
        description = await readFile(ctx.bodyFile, "utf8");
      } catch (err) {
        return { unavailable: `could not read the PR body from ${ctx.bodyFile}: ${err instanceof Error ? err.message : String(err)}` };
      }
      const body = JSON.stringify({
        title: ctx.title,
        source: { branch: { name: ctx.head } },
        destination: { branch: { name: ctx.base } },
        description,
      });
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests`, { method: "POST", body });
      if (r.kind === "no-token") return { unavailable: "BITBUCKET_API_TOKEN is not set" };
      if (r.kind === "refused") return { unavailable: "Bitbucket refused the request (token not accepted)" };
      if (r.kind === "missing") return { unavailable: "Bitbucket returned 404 creating the pull request" };
      if (r.kind === "unavailable") return { unavailable: r.message };
      if (looksLikePr(r.body)) {
        const checks = await fetchChecks(slug.workspace, slug.slug, r.body.id);
        const mergeable = await fetchMergeable(slug.workspace, slug.slug, r.body.id);
        return { found: toPrInfo(r.body, checks, mergeable) };
      }
      // Bitbucket refuses a second PR for the same branch (400, e.g. "branch already has an
      // open pull request"). A retried `creating-pr` must be idempotent, so adopt the
      // existing PR instead of reporting failure.
      const existing = await findPrByBranch(repoDir, ctx.head);
      if (existing) return { found: existing };
      const message = typeof r.body?.error?.message === "string" ? r.body.error.message : "Bitbucket refused to create the pull request";
      return { unavailable: message };
    },

    async findPr(repoDir: string, branch: string): Promise<PrInfo | null> {
      return findPrByBranch(repoDir, branch);
    },

    async getPr(repoDir: string, number: number): Promise<PrLookup> {
      return lookupByNumber(repoDir, number);
    },

    /** Open bugfix/ PRs, 50 per page. A listing carries no checks or conflicts: the watcher reads one PR
     *  in full only when its listed view moved, and conflicts come from local git (conflicts.ts). */
    async listOpenPrs(repoDir: string) {
      const slug = await resolveRepo(repoDir);
      if (!slug.ok) return { unavailable: slug.reason };
      const q = 'source.branch.name ~ "bugfix/" AND state="OPEN"';
      let path: string | null = `/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests?pagelen=50&q=${encodeURIComponent(q)}`;
      const prs: PrInfo[] = [];
      for (let page = 0; path && page < 50; page++) {
        const r = await api(path);
        if (r.kind === "no-token") return { unavailable: "BITBUCKET_API_TOKEN is not set" };
        if (r.kind === "refused") return { unavailable: "Bitbucket refused the request (token not accepted)" };
        if (r.kind === "missing") return { unavailable: "Bitbucket returned 404 listing pull requests" };
        if (r.kind === "unavailable") return { unavailable: r.message };
        for (const pr of Array.isArray(r.body?.values) ? r.body.values : []) if (looksLikePr(pr)) prs.push(toPrInfo(pr, null, null));
        const next = typeof r.body?.next === "string" ? r.body.next : null;
        path = next && next.startsWith(API) ? next.slice(API.length) : null;
      }
      return { prs };
    },

    async listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]> {
      const slug = await resolveRepo(repoDir);
      if (!slug.ok) return [];
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests/${number}/activity`);
      if (r.kind !== "ok") return [];
      const values = Array.isArray(r.body?.values) ? r.body.values : [];
      // An unparseable `since` makes `sinceMs` NaN, and every `ms > sinceMs` comparison below
      // is then false — filtering ALL events out to `[]`, deliberately. That favours dropping
      // events over admitting ones the caller can't place in time; it is easy to misread as a
      // bug on a later pass, so it's called out here rather than left implicit.
      const sinceMs = Date.parse(since);
      // Bitbucket reports no bot-account signal for pull-request participants today — `type`
      // is always "user" in the documented shape. Check it anyway so a future value ("bot")
      // is honoured rather than silently ignored; absent or unrecognised reads as false
      // (human), never true. `ReviewEvent.isBot` is a plain boolean with no way to express
      // "unknown", and the worst case of defaulting to human is a wasted feedback round
      // against the cap — never a bad merge, so this is the correct shared-platform default.
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

    async merge(repoDir: string, number: number, method: MergeMethod) {
      // Bitbucket's merge strategies are "merge_commit", "squash" and "fast_forward". None of
      // those is a rebase — `fast_forward` moves the base pointer without rewriting the PR's
      // commits, which is a different operation from a rebase merge. Silently substituting it
      // would perform something other than what the human clicked, on the one step that can't
      // be undone, so this is refused rather than mapped.
      if (method === "rebase") {
        return { ok: false, message: "Bitbucket has no rebase merge strategy; refusing rather than silently substituting a fast-forward." };
      }
      const slug = await resolveRepo(repoDir);
      if (!slug.ok) return { ok: false, message: slug.reason };
      const merge_strategy = method === "squash" ? "squash" : "merge_commit";
      const r = await api(`/repositories/${encodeURIComponent(slug.workspace)}/${encodeURIComponent(slug.slug)}/pullrequests/${number}/merge`,
        { method: "POST", body: JSON.stringify({ merge_strategy, close_source_branch: true }) });
      if (r.kind === "no-token") return { ok: false, message: "BITBUCKET_API_TOKEN is not set" };
      if (r.kind === "refused") return { ok: false, message: "Bitbucket refused the request (token not accepted)" };
      if (r.kind === "missing") return { ok: false, message: `Bitbucket returned 404 for PR #${number}` };
      if (r.kind === "unavailable") return { ok: false, message: r.message };
      const errorMessage = r.body?.error?.message;
      if (typeof errorMessage === "string") return { ok: false, message: errorMessage };
      if (!looksLikePr(r.body)) return { ok: false, message: "Bitbucket's response to the merge did not look like a pull request" };
      return { ok: true, message: `merged PR #${number} (${merge_strategy})` };
    },
  };
}
