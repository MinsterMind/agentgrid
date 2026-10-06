import type { Store } from "./store/store.js";
import type { ForgeAdapter } from "./bugfix/forge/types.js";
import type { AgentPr, Assignment, GridEvent } from "./types.js";

/** The PR a task names: a GitHub/Bitbucket link, "PR 42", "pull request #42", or a bare "#42". */
export function parsePrRef(text: string): number | null {
  const m = text.match(/\/pull(?:-requests)?\/(\d+)/) ?? text.match(/\b(?:PR|pull request|MR|merge request)\s*#?\s*(\d+)/i) ?? text.match(/(?:^|\s)#(\d+)\b/);
  return m ? Number(m[1]) : null;
}

/** The task for a second look: what moved since the last review, and the reviewer's own earlier findings. */
export function rereviewPrompt(pr: Pick<AgentPr, "number" | "url" | "headSha" | "reviewedSha">): string {
  const ref = `PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}`;
  const moved = pr.reviewedSha && pr.headSha && pr.reviewedSha !== pr.headSha
    ? ` The author has pushed since your last review: commits ${pr.reviewedSha.slice(0, 7)}..${pr.headSha.slice(0, 7)}.` : "";
  return `Re-review ${ref}.${moved} First check whether each of your earlier findings was addressed, then review what is new. End with a 2–3 line summary and whether it is ready to approve.`;
}

const FINAL = new Set(["MERGED", "CLOSED"]);

/**
 * Keeps the status of the PR each agent's current task names on that task, so the card can show it.
 * Polls slowly (a minute), and right away when a task that names a PR starts or finishes.
 * Stops asking once the PR is merged or closed. Writes only when something changed.
 */
export class AgentPrWatcher {
  private timer: NodeJS.Timeout | null = null; private soon: NodeJS.Timeout | null = null; private running = false;
  constructor(private deps: { store: Store; forge: () => ForgeAdapter | null; intervalMs?: number }) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { for (const ag of this.deps.store.listAgents()) if (ag.currentAssignmentId) await this.check(ag.repo, this.deps.store.getAssignment(ag.currentAssignmentId)); }
    finally { this.running = false; }
  }

  private async check(repo: string, a: Assignment): Promise<void> {
    const number = parsePrRef(a.prompt);
    if (number === null || (a.pr?.state && FINAL.has(a.pr.state))) return;
    const forge = this.deps.forge();
    let next: AgentPr;
    if (!forge) next = { number, note: "Set up GitHub or Bitbucket in Settings to see this PR's status" };
    else {
      const r = await forge.getPr(repo, number).catch((e: Error) => ({ unavailable: e.message }));
      if ("unavailable" in r) next = { number, note: `Couldn't read the PR: ${r.unavailable}` };
      else if (!r.found) next = { number, note: `PR #${number} wasn't found in this repo` };
      else {
        const p = r.found;
        const reviewedSha = a.pr?.reviewedSha ?? (a.state === "done" && p.headSha ? p.headSha : undefined);
        next = { number, url: p.url, state: p.state, reviewDecision: p.reviewDecision, checks: p.checks, headSha: p.headSha, ...(reviewedSha ? { reviewedSha } : {}) };
      }
    }
    const fresh = this.deps.store.getAssignment(a.id);   // the run may have moved on while we asked
    if (JSON.stringify(fresh.pr ?? null) !== JSON.stringify(next)) await this.deps.store.updateAssignment(a.id, { pr: next });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 60_000); this.timer.unref?.();
    // A task that names a PR and has no status yet, or a review that just finished: look now, not in a minute.
    this.deps.store.on("event", (e: GridEvent) => {
      if (e.type !== "assignment") return;
      const a = e.assignment;
      const due = parsePrRef(a.prompt) !== null && (!a.pr || (a.state === "done" && !a.pr.reviewedSha && a.pr.state === "OPEN" && !!a.pr.headSha));
      if (due && !this.soon) this.soon = setTimeout(() => { this.soon = null; void this.tick(); }, 500);
    });
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.soon) clearTimeout(this.soon); this.timer = this.soon = null; }
}
