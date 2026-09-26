import { shellQuote } from "../../shell.js";
import type { CreatePrContext, ForgeAdapter, PrInfo, Runner } from "./types.js";

const FIELDS = "number,url,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup";

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

export function githubAdapter(run: Runner): ForgeAdapter {
  return {
    name: "github",
    async authStatus() {
      const r = await run("gh", ["auth", "status"]);
      return { ok: r.code === 0, message: r.stdout.trim() || "gh auth status failed" };
    },
    createPrCommand(ctx: CreatePrContext) {
      return `gh pr create --base ${shellQuote(ctx.base)} --head ${shellQuote(ctx.head)} --title ${shellQuote(ctx.title)} --body-file ${shellQuote(ctx.bodyFile)}`;
    },
    async findPr(repoDir: string, branch: string): Promise<PrInfo | null> {
      // `gh`'s default ordering isn't a reliability guarantee: a branch can have both an old
      // closed PR and a current open one. Prefer the live PR; only fall back to --state all
      // (picking up a merged/closed PR) once the open query ran cleanly and simply found none.
      // A hard failure (non-zero exit, unparseable JSON) is never retried with a second query —
      // it degrades straight to null, same as every other findPr failure path.
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
      return {
        number: pr.number, url: pr.url,
        state: (pr.state ?? "OPEN").toUpperCase() as PrInfo["state"],
        reviewDecision: pr.reviewDecision ?? null,
        checks: rollup(pr.statusCheckRollup),
        mergeable: pr.mergeable ?? null,
        lastSeenEventAt: pr.updatedAt ?? new Date().toISOString(),
      };
    },
  };
}
