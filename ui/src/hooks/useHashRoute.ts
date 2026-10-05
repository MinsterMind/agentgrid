import { useCallback, useEffect, useState } from "react";

export type Route = { view: "grid" | "bugs"; bugId: string | null };

/** `#/bugs/<id>` → the bug screen on that bug. Only our own id shape is accepted as an id. */
export function parseHash(hash: string): Route {
  const m = /^#\/bugs(?:\/(.*))?$/.exec(hash);
  if (!m) return { view: "grid", bugId: null };
  return { view: "bugs", bugId: m[1] && /^bt\d+$/.test(m[1]) ? m[1] : null };
}

export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: { view: "grid" } | { view: "bugs"; bugId?: string | null }) => {
    const hash = r.view === "grid" ? "" : r.bugId ? `#/bugs/${r.bugId}` : "#/bugs";
    if (hash === "") history.pushState(null, "", window.location.pathname + window.location.search);
    else window.location.hash = hash;
    setRoute(parseHash(hash));
  }, []);
  return { ...route, go };
}
