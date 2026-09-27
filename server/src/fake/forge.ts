import type { ForgeAdapter, MergeMethod, PrLookup, ReviewEvent } from "../bugfix/forge/types.js";
import type { PrInfo } from "../bugfix/types.js";

export interface ScriptedStep { after: number; pr: Partial<PrInfo>; events?: ReviewEvent[] }

// headSha starts null rather than a fabricated value: this forge has no real git access, so it
// cannot track what a real `git push` actually landed. `doPush`'s own post-push confirmation
// (engine.ts) treats a falsy headSha as "no evidence either way" and skips the comparison —
// exactly the documented fallback for an adapter that doesn't report it — rather than comparing
// against a value that could never honestly match the real commit a push just made.
const BASE: PrInfo = { number: 1, url: "https://example.invalid/pr/1", state: "OPEN", reviewDecision: null,
  checks: "SUCCESS", mergeable: "MERGEABLE", headSha: null, lastSeenEventAt: "2026-09-26T09:00:00Z" };

/**
 * A forge that tells a story. Each step applies once `after` getPr calls have happened, so a
 * test (or the e2e) advances the story simply by letting the watcher poll — no clock control
 * and no sleeping. `merge` flips the PR to MERGED so the engine's own confirmation read
 * succeeds the way it would against a real forge.
 */
export function fakeForge(script: ScriptedStep[] = []): ForgeAdapter {
  let calls = 0;
  let pr: PrInfo = { ...BASE };
  let events: ReviewEvent[] = [];
  const apply = () => {
    for (const s of script) if (s.after === calls) { pr = { ...pr, ...s.pr }; events = s.events ?? []; }
  };
  return {
    name: "fake",
    authStatus: async () => ({ ok: true, message: "fake forge" }),
    createPrCommand: () => "echo 'fake pr created'",
    findPr: async () => ({ ...pr }),
    getPr: async () => { calls += 1; apply(); return { found: { ...pr } } as PrLookup; },
    listReviewEvents: async (_r, _n, since) => events.filter(e => e.at > since),
    merge: async (_r, _n, method: MergeMethod) => { pr = { ...pr, state: "MERGED" }; return { ok: true, message: `merged (${method}, fake)` }; },
  };
}
