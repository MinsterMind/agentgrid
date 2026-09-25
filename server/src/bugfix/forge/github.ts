import { shellQuote } from "../../shell.js";
import type { CreatePrContext, ForgeAdapter, PrInfo, Runner } from "./types.js";

const FIELDS = "number,url,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup";

/** Roll many check states into one: any failure wins, else pending, else success. */
function rollup(checks: Array<{ state?: string; conclusion?: string }> | undefined): string | null {
  if (!checks?.length) return null;
  const states = checks.map(c => (c.state ?? c.conclusion ?? "").toUpperCase());
  if (states.some(s => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s))) return "FAILURE";
  if (states.some(s => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes(s))) return "PENDING";
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
      const r = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS], repoDir);
      if (r.code !== 0) return null;
      let rows: any[] = [];
      try { rows = JSON.parse(r.stdout || "[]"); } catch { return null; }
      const pr = rows[0];
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
