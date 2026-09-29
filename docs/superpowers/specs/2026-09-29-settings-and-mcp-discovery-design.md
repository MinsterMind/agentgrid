# The Settings Screen and MCP Discovery — Design Spec

**Date:** 2026-09-29
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-29-bitbucket-and-settings-design.md`, whose §6 this replaces
**Ships in:** 0.4.0

## 1. Problem

The bug-fix workflow is configured by a file nothing creates and nothing
validates. `~/.agentgrid/integrations.json` is written only by
`rememberRepo` and `PUT /api/integrations`; on a machine that has never
saved either, it does not exist. The server then boots with no tracker,
and every bug-fix route answers `501 the bug-fix workflow is not
configured` — a message naming neither the file, the missing key, nor the
fact that a file was expected at all.

This has now cost the same user two sessions. Both times the diagnosis
required reading server source to learn that the message means *the
tracker is absent at boot*, and that a forge problem produces a different
message entirely.

The previous spec listed a Settings screen and deliberately deferred it.
The adapter work shipped; the discovery half did not.

## 2. Goal

Make the setup state visible and self-explaining from inside the app:
import an MCP server definition where one exists on disk, say plainly
what is missing where it does not, and let first-time setup take effect
without a restart.

## 3. What is actually discoverable

Verified on a real machine, 2026-09-29, before designing:

- `~/.claude.json` has no top-level `mcpServers` key, and none in any of
  its 27 `projects` entries.
- `~/.claude/settings.json` defines no MCP servers.
- No `.mcp.json` exists in the scanned tree.
- `claudeAiMcpEverConnected` lists four account-level connectors —
  `["claude.ai Kite mcp", "claude.ai Google Drive", "claude.ai Claude Code
  Remote", "claude.ai Claude Docs"]` — **by name only**.
- `claude mcp list` has no `--json` and no way to skip its health check.
  It opens a connection to every server and did not return within two
  minutes.

Two conclusions bind the design. **Account-level (claude.ai) connectors
keep their definitions server-side and cannot be imported** — there is
nothing on disk to copy. And **discovery must read files directly**; the
CLI is far too slow for a UI path.

This revises decision 4 of the previous spec ("Settings instructs rather
than discovers"): it now discovers what is discoverable and instructs
where it cannot.

## 4. Discovery

`server/src/bugfix/mcp-discovery.ts` — read-only, no subprocess, no
network.

| Source | Yields |
|---|---|
| `~/.claude.json` → `mcpServers` | user-scoped servers, full definitions |
| `~/.claude.json` → `projects[<repo>].mcpServers` | project-scoped, full definitions |
| `<repo>/.mcp.json` | repo-scoped, full definitions (may be pending approval) |
| `~/.claude/settings.json` | servers defined there |
| `~/.claude.json` → `claudeAiMcpEverConnected` | account-level connectors, names only |

Every source is optional. Every file is parsed independently, so one
malformed file cannot blank the result; it becomes a reported problem
naming the file and the parse error. A missing `~/.claude` is "nothing
found", not an error.

Each result is either **importable** (carries a definition) or
**known-but-not-importable** (a name from the account-level list). That
distinction is the honest core of the feature.

Importing copies the chosen server's definition verbatim into
`integrations.json`'s `tracker.mcpServers` and derives `toolPrefix` as
`mcp__<name>`. A repo-scoped definition is imported with its origin
noted, rather than refused. **Nothing under `~/.claude` is ever written.**

## 5. Readiness

Every bug-fix route goes through a guard that throws when the engine is
null, so the one moment a diagnosis is most needed is the one moment the
API cannot give one. `GET /api/setup` is therefore registered **outside**
that guard and always answers.

```ts
type CheckId = "config-file" | "tracker" | "tracker-reachable"
             | "forge" | "forge-username" | "forge-token" | "forge-auth" | "role";

interface Check {
  id: CheckId;
  state: "ok" | "missing" | "broken" | "unknown";
  detail: string;                  // what is true right now
  fix?: { kind: "command" | "env" | "field" | "action"; value: string };
  blocks: boolean;                 // does this stop a bug fix from starting
}
```

- **config-file** — does `integrations.json` exist and parse? A corrupt
  file today only logs at boot; here it is a first-class `broken` state
  carrying the parse error.
- **tracker** — configured or not; the §4 discovery result rides along so
  the UI can offer Import or the add command.
- **tracker-reachable** — on demand only (the Test button), never
  computed when the page opens.
- **forge**, **forge-username**, **forge-token**, **forge-auth** — split
  because they fail differently: no preset; a bitbucket preset whose
  blank `username` silently yields a null forge; `BITBUCKET_API_TOKEN`
  absent **from the server process**, which is the diagnostic that
  matters because the desktop app imports the login shell at launch; and
  a token the forge refuses.
- **role** — the `bugfix` role resolves. It ships as
  `server/roles/bugfix.md` and is loaded from the app's defaults, so it
  normally resolves even when `~/.agentgrid/roles` does not contain it;
  the check verifies resolution, not the user directory. (The engine's
  existing `preflight` message says "missing from `~/.agentgrid/roles`",
  which is misleading for exactly this reason — worth correcting while
  here.)

The token check is a boolean presence test on `process.env`. The value is
never returned, never logged, never sent to the UI.

Guidance adapts because it is **derived, not authored**: the UI renders
whatever comes back non-`ok`, each with its own `fix`. There is no list
of instructions to keep in sync. `blocks` drives the Fix-a-bug summary,
so a missing token does not nag while a tracker is still absent.

## 6. The two surfaces

`ui/src/components/SettingsDialog.tsx`, following the existing
`SpawnDialog`/`BugLauncher` pattern, opened from a **⚙︎ Settings** button
beside **🐞 Fix a bug** in `TopBar.tsx`.

**Tracker.** State first: *not configured* / *configured* / *unreachable*.
Then whichever applies: importable servers, each with **Import**; or, for
an account-level connector, a plain statement that its definition lives
server-side and cannot be imported, with a copyable
`claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp`
and a **Detect** to re-scan after running it; or, with nothing found, the
same command plus **Paste a definition** as the escape hatch. **Test**
runs a real `listMyIssues` and reports the count or the actual error.

**Forge.** `github` or `bitbucket`. Bitbucket collects the Atlassian
email and reports whether the token is visible to the server process,
with the export-then-restart note. **Test** calls `authStatus` and names
the account. `rebase` is omitted from the merge methods for Bitbucket.

**Repos.** The project→repo map, read-only with a clear action per row.

**`BugLauncher.tsx`** replaces today's red `the bug-fix workflow is not
configured` with a short line naming the blocking checks and a button
that opens Settings.

The command shown is an editable default, not a constant to be trusted
forever — the previous `…/v1/sse` endpoint stopped being supported after
30 June 2026.

## 7. Writes, and when they take effect

Saving goes through the existing `PUT /api/integrations`, which creates
the file when absent. That alone closes the reported gap.

**Live wiring, once.** If the engine is currently null, the server builds
the tracker, forge, engine and watcher on save and the feature becomes
live with no restart: with no engine, no bug task can exist, so nothing
is disrupted. If an engine already exists, the save is stored and the UI
says a restart is required — an engine and watcher are never rebuilt
under running tasks. This narrows decision 5 of the previous spec rather
than reversing it.

`start.ts`'s inline construction moves behind a `wireBugFix(cfg)`
function the app can call again, with the app holding a mutable
reference. **That reference is the only genuinely risky part of this
design**, so the transition is absent→present exactly once per process
lifetime; it is never a re-wire.

## 8. Security

- The scan is read-only and confined to MCP server definitions. It does
  not read transcripts, history, or project data.
- Nothing under `~/.claude` is written, ever.
- An imported definition may itself contain a credential (an
  `Authorization` header on an HTTP server). It is stored in
  `integrations.json` exactly as Claude Code already stores it, never
  logged, and never echoed to the UI — the UI sees a server's name,
  transport and URL, not its headers.
- Settings never collects a secret. `BITBUCKET_API_TOKEN` stays an
  environment variable the user exports; the app reports only whether it
  is present.

## 9. Testing

- **Discovery:** fixture trees for user-scoped, project-scoped,
  `.mcp.json`, account-level-only, a malformed file beside a good one,
  and a missing `~/.claude`.
- **`GET /api/setup`:** a test per check state, including every
  subsystem null — the case the current API cannot express.
- **Live wiring:** it fires only from null, and a second save does not
  rebuild.
- **UI:** nothing configured, importable found, account-level only, token
  missing, all green.
- **E2E:** the existing walk stays green on GitHub.
- Nothing in CI reads a real `~/.claude` or calls a live forge.

## 10. Out of scope

Running `claude mcp add` on the user's behalf; editing anything under
`~/.claude`; hot-reloading an already-working configuration; storing the
Bitbucket token in the OS keychain; GitLab.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The mutable engine reference is misused as a re-wire | One absent→present transition per process; tested that a second save does not rebuild |
| Claude Code changes where it stores MCP servers | Every source is optional and independently parsed; unknown shapes degrade to "nothing found", never to an error |
| An imported definition carries a credential into `integrations.json` | Never logged, never echoed to the UI; same trust level as the file it came from |
| The `claude mcp add` command drifts, as the SSE endpoint already did | Shown as an editable default; Detect and Test verify reality rather than trusting it |
| Users expect account-level connectors to be importable | The UI states why they cannot be, in place, rather than failing |
