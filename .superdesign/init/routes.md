# Routes

Framework: React 19 + Vite (SPA), TypeScript. No component library — all components are custom. CSS: one hand-written vanilla stylesheet (`ui/src/styles.css`), class-based, no Tailwind/CSS modules. Routing: hash-based (`ui/src/hooks/useHashRoute.ts`). Dark-only theme. Desktop app wraps it in Electron.

Hash routes (`ui/src/hooks/useHashRoute.ts`):

| URL | View | Component |
|---|---|---|
| `#/` (or empty) | Agent grid + side panel | `App.tsx` → `AgentGrid`, `SidePanel` |
| `#/bugs` | Bug screen, first bug selected | `BugScreen` |
| `#/bugs/<bt id>` | Bug screen on that bug | `BugScreen` |

Overlays (not routes): `SpawnDialog` (+ Spawn), `BugLauncher` (🐞 Fix a bug), `SettingsDialog` (⚙︎ Settings), `SessionsPanel` (Sessions), `TranscriptView` (full transcript).

Key pages:
- **Grid** — the home: sections of agent tiles (working, waiting, done, free…) with live activity, plus unclaimed live Claude sessions that can be pulled in; clicking a tile opens the side panel.
- **Bug screen** — one bug fix end to end: list of bugs, pipeline strip, Now, Blocking, approval actions, assumptions & questions, plan, changes, timeline.
- **Settings** — tracker (MCP server from Claude Code) and forge (GitHub/Bitbucket) setup with checks and fixes.

### `ui/src/hooks/useHashRoute.ts`

```ts
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
  /** `replace` rewrites the current entry instead of pushing one — for a selection the screen
   *  makes on its own (falling back to the first bug), which must not become a Back step that
   *  re-triggers itself and traps the user on #/bugs. */
  const go = useCallback((r: { view: "grid" } | { view: "bugs"; bugId?: string | null }, opts?: { replace?: boolean }) => {
    const hash = r.view === "grid" ? "" : r.bugId ? `#/bugs/${r.bugId}` : "#/bugs";
    const url = hash || window.location.pathname + window.location.search;
    if (opts?.replace) history.replaceState(null, "", url);
    else if (hash === "") history.pushState(null, "", url);
    else window.location.hash = hash;
    setRoute(parseHash(hash));
  }, []);
  return { ...route, go };
}
```
