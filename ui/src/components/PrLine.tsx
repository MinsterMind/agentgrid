import { GitPullRequestArrow, RefreshCw } from "lucide-react";
import type { AgentPr } from "../types";

const STATE: Record<string, [string, string]> = { OPEN: ["Open", "cyan"], MERGED: ["Merged", "green"], CLOSED: ["Closed", ""] };
const REVIEW: Record<string, [string, string]> = { APPROVED: ["Approved", "green"], CHANGES_REQUESTED: ["Changes requested", "amber"] };
const CHECKS: Record<string, [string, string]> = { SUCCESS: ["Checks pass", "green"], FAILURE: ["Checks failing", "red"], PENDING: ["Checks running", ""] };

/** The PR a task names, read from the forge: where it stands, whether it moved since the review,
 *  and — while it is open and not yet approved — a second look by the same reviewer. */
export function PrLine({ pr, canReReview, onReReview }: { pr: AgentPr; canReReview: boolean; onReReview?: () => void }) {
  const chips: Array<[string, string]> = [];
  if (pr.state) chips.push(STATE[pr.state]);
  if (pr.state === "OPEN") chips.push(REVIEW[pr.reviewDecision ?? ""] ?? ["Awaiting approval", ""]);
  if (pr.state === "OPEN" && pr.checks && CHECKS[pr.checks]) chips.push(CHECKS[pr.checks]);
  const moved = pr.state === "OPEN" && !!pr.reviewedSha && !!pr.headSha && pr.reviewedSha !== pr.headSha;
  const offer = canReReview && pr.state === "OPEN" && pr.reviewDecision !== "APPROVED" && !!onReReview;
  return (
    <div className="tile-pr" data-testid="tile-pr" onClick={e => e.stopPropagation()}>
      <div className="row">
        <GitPullRequestArrow />
        {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}</a> : <span>PR #{pr.number}</span>}
        {chips.map(([label, tone]) => <span key={label} className={`chip ${tone}`}>{label}</span>)}
      </div>
      {pr.note && <div className="help">{pr.note}</div>}
      {(moved || offer) && (
        <div className="row">
          {moved && <span className="moved">New commits since the review</span>}
          {offer && <button className="btn sm" title="The same reviewer checks its earlier findings and anything new" onClick={onReReview}><RefreshCw /> Re-review</button>}
        </div>
      )}
    </div>
  );
}
