/**
 * Which model each bug-fix stage runs on, and how far it may go (spec 2026-10-09 §6.2). Imports nothing
 * server-only, so the Settings screen shows the same defaults the server applies.
 */

/** The agent stages a model is chosen for. */
export type ModelStage = "analyzing" | "implementing" | "opening-pr" | "review-feedback" | "rebase";
export const MODEL_STAGES: ModelStage[] = ["analyzing", "implementing", "opening-pr", "review-feedback", "rebase"];
export type Effort = "low" | "medium" | "high" | "xhigh";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];
export interface StageRun { model: string; effort: Effort; maxTurns: number; maxBudgetUsd: number }
export type StageModels = Partial<Record<ModelStage, Partial<StageRun>>>;

export const MODELS = { opus: "claude-opus-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-4-5-20251001" } as const;
/** Weakest first: the order a failed stage steps up through. */
export const KNOWN_MODELS: string[] = [MODELS.haiku, MODELS.sonnet, MODELS.opus];
/** What a stage on each model may spend at least — a bump to a stronger model must not hit the weaker one's cap. */
const MIN_CAP: Record<string, number> = { [MODELS.haiku]: 0.25, [MODELS.sonnet]: 1.5, [MODELS.opus]: 3 };

export const DEFAULT_STAGE_RUNS: Record<ModelStage, StageRun> = {
  analyzing: { model: MODELS.opus, effort: "high", maxTurns: 40, maxBudgetUsd: 3 },
  implementing: { model: MODELS.sonnet, effort: "medium", maxTurns: 60, maxBudgetUsd: 2 },
  "opening-pr": { model: MODELS.haiku, effort: "low", maxTurns: 10, maxBudgetUsd: 0.25 },
  "review-feedback": { model: MODELS.sonnet, effort: "medium", maxTurns: 40, maxBudgetUsd: 1.5 },
  rebase: { model: MODELS.sonnet, effort: "medium", maxTurns: 40, maxBudgetUsd: 1.5 },
};

/** The run settings for a stage: defaults, then the user's settings, then a model this task was stepped up to. */
export function stageRun(stage: ModelStage, settings?: StageModels, bumped?: string): StageRun {
  const r: StageRun = { ...DEFAULT_STAGE_RUNS[stage], ...(settings?.[stage] ?? {}) };
  if (bumped && KNOWN_MODELS.includes(bumped)) { r.model = bumped; r.maxBudgetUsd = Math.max(r.maxBudgetUsd, MIN_CAP[bumped] ?? 0); }
  return r;
}

/** One model up — Haiku → Sonnet → Opus. Null at the top, or for a model we don't rank. */
export function stepUp(model: string): string | null {
  const i = KNOWN_MODELS.indexOf(model);
  return i === -1 || i === KNOWN_MODELS.length - 1 ? null : KNOWN_MODELS[i + 1];
}

/** The `stageModels` a client may save. Throws a 400 naming the bad field. */
export function validateStageModels(v: unknown): StageModels {
  const bad = (why: string): never => { throw Object.assign(new Error(`stageModels: ${why}`), { status: 400 }); };
  if (!v || typeof v !== "object" || Array.isArray(v)) bad("must be an object of stages");
  const out: StageModels = {};
  for (const [stage, s] of Object.entries(v as Record<string, unknown>)) {
    if (!(MODEL_STAGES as string[]).includes(stage)) bad(`"${stage}" is not one of ${MODEL_STAGES.join(", ")}`);
    if (!s || typeof s !== "object" || Array.isArray(s)) bad(`${stage} must be an object`);
    const o = s as Record<string, unknown>; const r: Partial<StageRun> = {};
    if (o.model !== undefined) { if (typeof o.model !== "string" || !KNOWN_MODELS.includes(o.model)) bad(`${stage}.model must be one of ${KNOWN_MODELS.join(", ")}`); r.model = o.model as string; }
    if (o.effort !== undefined) { if (!(EFFORTS as unknown[]).includes(o.effort)) bad(`${stage}.effort must be one of ${EFFORTS.join(", ")}`); r.effort = o.effort as Effort; }
    if (o.maxTurns !== undefined) { if (!Number.isInteger(o.maxTurns) || (o.maxTurns as number) < 1 || (o.maxTurns as number) > 300) bad(`${stage}.maxTurns must be a whole number from 1 to 300`); r.maxTurns = o.maxTurns as number; }
    if (o.maxBudgetUsd !== undefined) { if (typeof o.maxBudgetUsd !== "number" || !(o.maxBudgetUsd >= 0.05 && o.maxBudgetUsd <= 100)) bad(`${stage}.maxBudgetUsd must be from 0.05 to 100`); r.maxBudgetUsd = o.maxBudgetUsd as number; }
    out[stage as ModelStage] = r;
  }
  return out;
}
