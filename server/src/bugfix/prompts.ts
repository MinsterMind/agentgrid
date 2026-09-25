import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BugStage, BugTask } from "./types.js";

export interface StageContext {
  artifactsDir: string;
  planPath: string;
  prBodyPath: string;
  /** Verbatim command the agent must run in `opening-pr`. */
  createPrCommand?: string;
  /** Free text from a "request changes" gate. */
  note?: string;
}

const FILES: Partial<Record<BugStage, string>> = {
  analyzing: "analyze.md",
  implementing: "implement.md",
  "opening-pr": "open-pr.md",
};

/** Fill a stage prompt from `presets/stages/*.md`. Unknown placeholders render empty, never as "undefined". */
export async function renderStagePrompt(stage: BugStage, task: BugTask, ctx: StageContext, presetsDir: string): Promise<string> {
  const file = FILES[stage];
  if (!file) throw new Error(`stage ${stage} has no prompt`);
  if (stage === "opening-pr" && !ctx.createPrCommand?.trim()) {
    throw new Error(`stage opening-pr requires ctx.createPrCommand, but it was missing or empty`);
  }
  const template = await readFile(path.join(presetsDir, "stages", file), "utf8");
  const vars: Record<string, string> = {
    issueKey: task.issue.key, issueTitle: task.issue.title, issueUrl: task.issue.url,
    issueStatus: task.issue.status, issuePriority: task.issue.priority, issueDescription: task.issue.description,
    acceptanceCriteria: task.issue.acceptanceCriteria.length ? task.issue.acceptanceCriteria.map(a => `- ${a}`).join("\n") : "- (none given)",
    worktree: task.worktree, branch: task.branch, baseBranch: task.baseBranch,
    artifactsDir: ctx.artifactsDir, planPath: ctx.planPath, prBodyPath: ctx.prBodyPath,
    createPrCommand: ctx.createPrCommand ?? "",
    note: ctx.note?.trim() ? `## Additional instructions from the reviewer\n${ctx.note.trim()}` : "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
