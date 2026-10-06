import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BugTask } from "../types";

export type Preflight = { ok: boolean; problems: string[]; remote?: string | null; baseBranch?: string | null; branches?: string[] };

/**
 * Everything it takes to start a bug fix for one ticket: the repo (remembered per project), its
 * preflight, the branch to cut from, the merge policy, and the start itself — including the
 * "may already be fixed — Start anyway" refusal. Shared by the Fix a bug dialog and the ticket view.
 */
export function useBugStart({ issueRef, onCreated }: { issueRef: string; onCreated?: (task: BugTask) => void }) {
  const [repo, setRepo] = useState("");
  const [mergePolicy, setMergePolicy] = useState<"ask" | "auto">("ask");
  const [projectRepos, setProjectRepos] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [base, setBase] = useState("");
  // The ticket's fix may already be on the base: the server listed the commits; the human may start anyway.
  const [alreadyOnBase, setAlreadyOnBase] = useState(false);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.getIntegrations().then(i => { if (live) setProjectRepos(i.projectRepos ?? {}); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const repoTrimmed = repo.trim();
  const repoValid = repoTrimmed.startsWith("/");

  // Any previous preflight result describes the OLD repo value, not this one — it must never
  // outlive a repo edit, and Start must stay blocked until a fresh check for THIS value lands.
  useEffect(() => {
    setPreflight(null);
    if (!repoTrimmed || !repoValid) { setChecking(false); return; }
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.bugPreflight(repoTrimmed)
        .then(p => { if (live) { setPreflight(p); setBase(p.baseBranch ?? ""); setChecking(false); } })
        .catch(e => { if (live) { setErr((e as Error).message); setChecking(false); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [repoTrimmed, repoValid]);

  /** The repo this ticket's project was last fixed in, if any. */
  const rememberedFor = (key: string): string | undefined => projectRepos[key.split("-")[0] ?? ""];

  useEffect(() => { setAlreadyOnBase(false); }, [issueRef, repoTrimmed, base]);
  const start = async (startAnyway = false) => {
    setBusy(true); setErr(null);
    // Create first, then tell the parent: `onCreated?.(await …)` would skip the request entirely without a callback.
    try { const created = await api.createBugTask({ issueRef: issueRef.trim(), repo: repoTrimmed, mergePolicy, ...(base ? { baseBranch: base } : {}), ...(startAnyway ? { startAnyway: true } : {}) }); onCreated?.(created); }
    catch (e) { setErr((e as Error).message); setAlreadyOnBase(e instanceof ApiError && e.code === "already-on-base"); }
    finally { setBusy(false); }
  };

  const blocked = !issueRef.trim() || !repoTrimmed || !repoValid || busy || checking || !preflight || !preflight.ok;
  return { repo, setRepo, repoTrimmed, repoValid, projectRepos, rememberedFor, preflight, checking, base, setBase, mergePolicy, setMergePolicy, busy, err, setErr, alreadyOnBase, blocked, start };
}
