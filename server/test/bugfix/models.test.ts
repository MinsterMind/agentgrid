import { describe, it, expect } from "vitest";
import { DEFAULT_STAGE_RUNS, MODELS, stageRun, stepUp, validateStageModels } from "../../src/bugfix/models.js";

describe("stage models", () => {
  it("defaults: Opus plans, Sonnet changes, Haiku writes the PR description", () => {
    expect(DEFAULT_STAGE_RUNS.analyzing).toEqual({ model: MODELS.opus, effort: "high", maxTurns: 40, maxBudgetUsd: 3 });
    expect(DEFAULT_STAGE_RUNS.implementing).toEqual({ model: MODELS.sonnet, effort: "medium", maxTurns: 60, maxBudgetUsd: 2 });
    expect(DEFAULT_STAGE_RUNS["opening-pr"]).toEqual({ model: MODELS.haiku, effort: "low", maxTurns: 10, maxBudgetUsd: 0.25 });
    expect(DEFAULT_STAGE_RUNS["review-feedback"].model).toBe(MODELS.sonnet);
    expect(DEFAULT_STAGE_RUNS.rebase.model).toBe(MODELS.sonnet);
  });
  it("settings override field by field; a bumped model wins over both", () => {
    expect(stageRun("implementing", { implementing: { maxTurns: 90 } })).toEqual({ ...DEFAULT_STAGE_RUNS.implementing, maxTurns: 90 });
    expect(stageRun("implementing", { implementing: { model: MODELS.haiku } }, MODELS.opus).model).toBe(MODELS.opus);
  });
  it("a bump scales the cap to the stronger model (never lower than configured)", () => {
    const r = stageRun("opening-pr", undefined, MODELS.sonnet);
    expect(r.model).toBe(MODELS.sonnet);
    expect(r.maxBudgetUsd).toBeGreaterThanOrEqual(1.5);
  });
  it("steps up Haiku → Sonnet → Opus, and stops at Opus", () => {
    expect(stepUp(MODELS.haiku)).toBe(MODELS.sonnet);
    expect(stepUp(MODELS.sonnet)).toBe(MODELS.opus);
    expect(stepUp(MODELS.opus)).toBeNull();
    expect(stepUp("something-else")).toBeNull();
  });
  it("validation refuses unknown stages, models, efforts and out-of-range numbers", () => {
    expect(validateStageModels({ implementing: { model: MODELS.opus, maxTurns: 80 } })).toEqual({ implementing: { model: MODELS.opus, maxTurns: 80 } });
    expect(() => validateStageModels({ cooking: {} })).toThrow(/cooking/);
    expect(() => validateStageModels({ implementing: { model: "gpt-4" } })).toThrow(/model/);
    expect(() => validateStageModels({ implementing: { effort: "max" } })).toThrow(/effort/);
    expect(() => validateStageModels({ implementing: { maxTurns: 0 } })).toThrow(/maxTurns/);
    expect(() => validateStageModels({ implementing: { maxBudgetUsd: 500 } })).toThrow(/maxBudgetUsd/);
    try { validateStageModels({ cooking: {} }); } catch (e) { expect((e as { status?: number }).status).toBe(400); }
  });
});
