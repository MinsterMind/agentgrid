import { useCallback, useEffect, useState } from "react";

export type Route = { view: "grid" | "bugs"; bugId: string | null; ticket: string | null };

/** `#/bugs/<id>` → the bug screen on that bug; `#/bugs/ticket/<KEY>` → on a ticket not started yet.
 *  Only our own id shape and a real ticket-key shape are accepted. */
export function parseHash(hash: string): Route {
  const m = /^#\/bugs(?:\/(.*))?$/.exec(hash);
  if (!m) return { view: "grid", bugId: null, ticket: null };
  const t = /^ticket\/(.+)$/.exec(m[1] ?? "");
  if (t) return { view: "bugs", bugId: null, ticket: /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(t[1]) ? t[1] : null };
  return { view: "bugs", bugId: m[1] && /^bt\d+$/.test(m[1]) ? m[1] : null, ticket: null };
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  /** `replace` rewrites the current entry instead of pushing one — for a selection the screen
   *  makes on its own (falling back to the first bug), which must not become a Back step that
   *  re-triggers itself and traps the user on #/bugs. */
  const go = useCallback((r: { view: "grid" } | { view: "bugs"; bugId?: string | null; ticket?: string | null }, opts?: { replace?: boolean }) => {
    const hash = r.view === "grid" ? "" : r.bugId ? `#/bugs/${r.bugId}` : r.ticket ? `#/bugs/ticket/${r.ticket}` : "#/bugs";
    const url = hash || window.location.pathname + window.location.search;
    if (opts?.replace) history.replaceState(null, "", url);
    else if (hash === "") history.pushState(null, "", url);
    else window.location.hash = hash;
    setRoute(parseHash(hash));
  }, []);
  return { ...route, go };
}
