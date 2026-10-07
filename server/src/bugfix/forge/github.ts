import type { CreatePrContext, ForgeAdapter, MergeMethod, PrInfo, ReviewEvent, Runner } from "./types.js";

const FIELDS = "number,url,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup,headRefOid";
const PR_FIELDS = FIELDS;
/** gh says "no pull requests found" for a genuinely absent PR; anything else is a broken call. */
const NOT_FOUND = /no pull requests? found|could not resolve to a pullrequest/i;

const FAILURE_STATES = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"];
const SUCCESS_STATES = ["SUCCESS", "NEUTRAL", "SKIPPED"];

/**
 * Resolve one check's outcome. `gh pr list --json statusCheckRollup` returns a union: legacy
 * StatusContext items carry `state`; CheckRun items carry `status` (QUEUED/IN_PROGRESS/COMPLETED)
 * plus `conclusion` (null while running, set once COMPLETED). Unknown/unrecognised shapes must
 * never read as green — they resolve to PENDING, not SUCCESS.
 */
function checkOutcome(c: { status?: string; state?: string; conclusion?: string | null }): "SUCCESS" | "FAILURE" | "PENDING" {
  const status = (c.status ?? c.state ?? "").toUpperCase();
  const conclusion = (c.conclusion ?? "").toUpperCase();
  if (status === "COMPLETED") {
    if (SUCCESS_STATES.includes(conclusion)) return "SUCCESS";
    if (FAILURE_STATES.includes(conclusion)) return "FAILURE";
    return "PENDING"; // completed without a recognised conclusion
  }
  if (SUCCESS_STATES.includes(status)) return "SUCCESS";
  if (FAILURE_STATES.includes(status)) return "FAILURE";
  return "PENDING"; // PENDING/IN_PROGRESS/QUEUED/EXPECTED, or anything unrecognised
}

/** Roll many check outcomes into one: any failure wins, else any pending, else success. */
function rollup(checks: Array<{ status?: string; state?: string; conclusion?: string | null }> | undefined): string | null {
  if (!checks?.length) return null;
  const outcomes = checks.map(checkOutcome);
  if (outcomes.includes("FAILURE")) return "FAILURE";
  if (outcomes.includes("PENDING")) return "PENDING";
  return "SUCCESS";
}

/** Valid JSON is not necessarily a PR body — `{}`, `[]`, `null` all parse cleanly. A
 *  fabricated `found` is the one PrLookup state the watcher cannot recover from, so
 *  require the two fields that are never optional on a real `gh pr view` payload. */
function looksLikePr(pr: any): boolean {
  return typeof pr === "object" && pr !== null && !Array.isArray(pr)
    && typeof pr.number === "number" && typeof pr.url === "string";
}

function toPrInfo(pr: any): PrInfo {
  return {
    number: pr.number, url: pr.url, state: (pr.state ?? "OPEN").toUpperCase() as PrInfo["state"],
    reviewDecision: pr.reviewDecision ?? null, checks: rollup(pr.statusCheckRollup),
    mergeable: pr.mergeable ?? null, headSha: pr.headRefOid ?? null,
    lastSeenEventAt: pr.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * `gh`'s default ordering isn't a reliability guarantee: a branch can have both an old
 * closed PR and a current open one. Prefer the live PR; only fall back to --state all
 * (picking up a merged/closed PR) once the open query ran cleanly and simply found none.
 * A hard failure (non-zero exit, unparseable JSON) is never retried with a second query —
 * it degrades straight to null, same as every other findPr failure path.
 *
 * Extracted to a local function (rather than a `this.findPr` call from `createPr`) so the
 * adapter's methods don't depend on being invoked as `adapter.method()` — a plain object
 * literal with method shorthand would work either way, but a free function reads clearly
 * and needs no such assumption.
 */
async function findPrImpl(run: Runner, repoDir: string, branch: string): Promise<PrInfo | null> {
  const query = async (state: "open" | "all"): Promise<{ ok: true; pr: any | null } | { ok: false }> => {
    const r = await run("gh", ["pr", "list", "--head", branch, "--state", state, "--limit", "1", "--json", FIELDS], repoDir);
    if (r.code !== 0) return { ok: false };
    let rows: any[] = [];
    try { rows = JSON.parse(r.stdout || "[]"); } catch { return { ok: false }; }
    return { ok: true, pr: rows[0] ?? null };
  };
  const openResult = await query("open");
  if (!openResult.ok) return null;
  let pr = openResult.pr;
  if (!pr) {
    const allResult = await query("all");
    if (!allResult.ok) return null;
    pr = allResult.pr;
  }
  if (!pr) return null;
  return toPrInfo(pr);
}

export function githubAdapter(run: Runner): ForgeAdapter {
  return {
    name: "github",
    async authStatus() {
      const r = await run("gh", ["auth", "status"]);
      return { ok: r.code === 0, message: r.stdout.trim() || "gh auth status failed" };
    },
    async createPr(repoDir: string, ctx: CreatePrContext) {
      const r = await run("gh", ["pr", "create", "--base", ctx.base, "--head", ctx.head,
        "--title", ctx.title, "--body-file", ctx.bodyFile], repoDir);
      const message = r.stderr?.trim() || r.stdout?.trim() || `gh exited ${r.code}`;
      // A duplicate is not a failure: a retry after a crash mid-creation must converge —
      // adopt the PR that already exists for this branch instead of failing.
      if (r.code !== 0 && !/already exists/i.test(message)) {
        return { unavailable: message };
      }
      // Verify rather than trust the exit code: read the PR back by branch.
      const pr = await findPrImpl(run, repoDir, ctx.head);
      if (pr) return { found: pr };
      // The create call itself failed (even if with an "already exists" message) and no PR
      // could be found for the branch: surface the original failure, not a synthetic one.
      return { unavailable: r.code !== 0 ? message : "the pull request was not found after creating it" };
    },
    async findPr(repoDir: string, branch: string): Promise<PrInfo | null> {
      return findPrImpl(run, repoDir, branch);
    },

    async getPr(repoDir: string, number: number) {
      const r = await run("gh", ["pr", "view", String(number), "--json", PR_FIELDS], repoDir);
      if (r.code !== 0) {
        const msg = (r.stderr ?? r.stdout ?? "").trim() || `gh exited ${r.code}`;
        return NOT_FOUND.test(msg) ? { found: null } : { unavailable: msg };
      }
      let parsed: any;
      try { parsed = JSON.parse(r.stdout); }
      catch { return { unavailable: `could not read gh output for PR #${number}` }; }
      if (!looksLikePr(parsed)) return { unavailable: `gh output for PR #${number} did not look like a pull request` };
      return { found: toPrInfo(parsed) };
    },

    /** My open PRs in one `gh pr list` (paged internally, 100 per page). */
    async listOpenPrs(repoDir: string) {
      const r = await run("gh", ["pr", "list", "--state", "open", "--author", "@me", "--limit", "3000", "--json", FIELDS], repoDir);
      if (r.code !== 0) return { unavailable: (r.stderr ?? r.stdout ?? "").trim() || `gh exited ${r.code}` };
      let rows: any[];
      try { rows = JSON.parse(r.stdout || "[]"); } catch { return { unavailable: "gh pr list returned something that isn't JSON" }; }
      return { prs: (Array.isArray(rows) ? rows : []).filter(looksLikePr).map(toPrInfo) };
    },

    async listReviewEvents(repoDir: string, number: number, since: string): Promise<ReviewEvent[]> {
      // `gh pr view --json reviews,comments` builds its author objects from GraphQL, whose
      // Bot.login carries no `[bot]` suffix and no bot field at all on a per-review/per-comment
      // author — that's only true of `--json author` (the PR's own author). REST is the
      // authoritative source here: `user.type === "Bot"` is real, and `gh api`'s `{owner}`/
      // `{repo}` placeholders resolve from repoDir (passed as cwd) the same way `gh pr` does.
      // Two calls instead of one GraphQL query is acceptable — this only runs when a PR
      // actually changed and changes were requested.
      const [reviewsR, commentsR] = await Promise.all([
        run("gh", ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`], repoDir),
        run("gh", ["api", `repos/{owner}/{repo}/issues/${number}/comments`], repoDir),
      ]);
      const parseArray = (r: { stdout: string; code: number }): any[] => {
        if (r.code !== 0) return [];
        try { const v = JSON.parse(r.stdout || "[]"); return Array.isArray(v) ? v : []; }
        catch { return []; }
      };
      // REST's `user.type === "Bot"` is the real signal (dependabot, github-actions, ...);
      // the `[bot]` login suffix is kept only as corroboration/fallback. What neither field
      // catches: a PAT-driven service *user* account reports `type: "User"` with no suffix
      // and is indistinguishable from a human by anything either API exposes.
      const isBot = (u: any) => Boolean(u?.type === "Bot" || /\[bot\]$/i.test(u?.login ?? ""));
      const out: ReviewEvent[] = [
        ...parseArray(reviewsR).map((v: any) => ({ kind: "review" as const, state: (v.state ?? "").toUpperCase(),
          author: v.user?.login ?? "", isBot: isBot(v.user), body: v.body ?? "", at: v.submitted_at ?? "" })),
        ...parseArray(commentsR).map((c: any) => ({ kind: "comment" as const, state: "",
          author: c.user?.login ?? "", isBot: isBot(c.user), body: c.body ?? "", at: c.created_at ?? "" })),
      ];
      return out.filter(e => e.at > since).sort((a, b) => a.at.localeCompare(b.at));
    },

    async merge(repoDir: string, number: number, method: MergeMethod) {
      // No `--delete-branch`: it deletes the LOCAL branch too, and the task branch is checked out
      // in the linked worktree while this runs, so git refuses ("cannot delete branch ... used by
      // worktree"), gh exits non-zero, and a merge that irreversibly happened comes back as
      // `ok: false` — presenting a successful merge as "Stage failed", which spec §5.4 forbids.
      // The engine deletes the remote branch itself once the merge is confirmed (`doMerge`), where
      // a failure can only ever become a cleanup note.
      const flag = method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge";
      const r = await run("gh", ["pr", "merge", String(number), flag], repoDir);
      const message = ((r.code === 0 ? r.stdout : (r.stderr ?? r.stdout)) ?? "").trim();
      return { ok: r.code === 0, message: message || (r.code === 0 ? "merged" : `gh exited ${r.code}`) };
    },
  };
}
