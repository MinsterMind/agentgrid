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

/** A `fakeForge()` with one extra, test-only handle: how many times `createPr` was actually
 *  called. The offline loop uses it to prove the *server* opened the pull request — a single
 *  `createPr` call — rather than an agent having done it via a CLI the fake can't see. */
export type FakeForge = ForgeAdapter & { createPrCalls(): number;
  /** Test hooks: the repo's open PRs (what an import finds), a merged PR for any key, the review events. */
  setOpenPrs(prs: PrInfo[]): void; setMerged(pr: PrInfo | null): void; setEvents(events: ReviewEvent[]): void;
  /** Something happened on every PR: its last-seen time moves, so the watcher reads it. */ touch(): void };

/**
 * A forge that tells a story. Each step applies once `after` getPr calls have happened, so a
 * test (or the e2e) advances the story simply by letting the watcher poll — no clock control
 * and no sleeping. `merge` flips the PR to MERGED so the engine's own confirmation read
 * succeeds the way it would against a real forge.
 */
export function fakeForge(script: ScriptedStep[] = []): FakeForge {
  let calls = 0;
  let createPrCalls = 0;
  let pr: PrInfo = { ...BASE };
  let events: ReviewEvent[] = [];
  let openPrs: PrInfo[] = [];
  let merged: PrInfo | null = null;
  const apply = () => {
    for (const s of script) if (s.after === calls) { pr = { ...pr, ...s.pr }; events = s.events ?? []; }
  };
  return {
    name: "fake",
    authStatus: async () => ({ ok: true, message: "fake forge" }),
    createPr: async () => { createPrCalls += 1; return { found: { ...pr } }; },
    findPr: async () => ({ ...pr }),
    // An open PR the repo lists (an import's) answers by its own number; anything else is the scripted story.
    getPr: async (_r, n) => { calls += 1; apply(); const listed = openPrs.find(p => p.number === n); return { found: { ...(listed ?? pr) } } as PrLookup; },
    listReviewEvents: async (_r, _n, since) => events.filter(e => e.at > since),
    merge: async (_r, _n, method: MergeMethod) => { pr = { ...pr, state: "MERGED" }; return { ok: true, message: `merged (${method}, fake)` }; },
    createPrCalls: () => createPrCalls,
    // Only an import asks for every open PR; the watcher's own listing is empty, so each watched PR is read on its own as before.
    listOpenPrs: async (_r, opts) => ({ prs: opts?.all ? openPrs.map(p => ({ ...p })) : [] }),
    findMergedPr: async () => merged,
    whoami: async () => ({ login: "me" }),
    setOpenPrs: (prs: PrInfo[]) => { openPrs = prs; },
    setMerged: (pr: PrInfo | null) => { merged = pr; },
    setEvents: (e: ReviewEvent[]) => { events = e; },
    touch: () => { const at = new Date().toISOString(); pr = { ...pr, lastSeenEventAt: at }; openPrs = openPrs.map(p => ({ ...p, lastSeenEventAt: at })); },
  };
}
