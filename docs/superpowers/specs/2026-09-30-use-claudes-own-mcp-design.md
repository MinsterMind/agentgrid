# Use Claude's Own MCP Configuration — Design Spec

**Date:** 2026-09-30
**Status:** Approved design, pre-implementation
**Supersedes:** §4 (Discovery) and §6.1 (Tracker) of `2026-09-29-settings-and-mcp-discovery-design.md`
**Ships in:** 0.5.0

## 1. Problem

0.4.0 shipped a Settings screen that **imports** an MCP server definition out of
Claude Code's configuration and into `~/.agentgrid/integrations.json`. For the
user it was built for, the Import button never appeared: their Jira is
`claude.ai Atlassian`, an account-level connector whose definition lives on
Atlassian's servers. The screen correctly reported that nothing could be
imported and offered a `claude mcp add` command — asking them to create a
second, local copy of a connection they already had.

That was the wrong shape. It was built on an assumption nobody tested: that an
agent can only reach an MCP server whose definition AgentGrid passes it.

## 2. What is actually true

Verified on 2026-09-30 against this machine's real configuration, through
AgentGrid's own `realQuery` path — not the CLI, and not by reasoning.

**An account-level connector is usable from the SDK with no `mcpServers`
config at all.** With none passed, an agent called
`mcp__claude_ai_Claude_Docs__guide` and returned its output.

**Naming the prefix in `allowedTools` is what connects it.** Without it, the
session reported every connector `status: "pending"` and exposed none of their
tools (24 tools, none `mcp__`). With `allowedTools: ["mcp__claude_ai_Claude_Docs"]`,
the same connectors reported `status: "connected"` and the sub-tool was
callable. So `allowedTools` prefix-matching works, which is what `mcpTracker`
already depends on.

**The prefix is derivable from the connector name.** `claude.ai Claude Docs` →
`mcp__claude_ai_Claude_Docs`; `claude.ai Kite mcp` → `mcp__claude_ai_Kite_mcp`.
Rule: `claude.ai ` → `claude_ai_`, spaces → underscores, prefixed with `mcp__`.

**A config-defined server also needs no copy — but only if its setting source
is enabled.** Probed the same way: with `settingSources: ["user"]` a project's
`.mcp.json` server does not load at all; with `["user", "project"]` it appears
as `probe_local:failed:project` — failed only because the probe's command was
not a real MCP server, which is beside the point: it was loaded from config.
`mcpTracker` passes `["user"]` today, so it must gain `"project"`, or the
project- and repo-scoped rows §5 lists would be listed and then fail at the
first call.

(Whether user scope — `~/.claude.json` → `mcpServers` — loads under `"user"`
is unverified: this machine defines none. It is the documented meaning of the
source, and the Test button surfaces a failure immediately.)

The consequence: **AgentGrid never needed a copy.** It needs one string, and
the setting sources that make the string resolvable.

## 3. Goal

Stop holding a second copy of the user's connections. Use what Claude Code
already has, and reduce Settings to naming which of those is the tracker.

## 4. Configuration

`TrackerConfig` becomes:

```ts
export interface TrackerConfig { preset: string; toolPrefix: string; hints?: string }
```

`mcpServers` is **removed**, not deprecated. Removing it deletes the only place
AgentGrid stored someone else's credential, and with it the entire class of
leak defects fixed in 0.4.0 (a parse error echoing a bearer token; `GET` and
`PUT /api/integrations` returning definitions to the browser). Those fixes stay
— but the thing they protected no longer exists.

**Migration:** a config carrying `mcpServers` still loads; the field is ignored
and dropped on the next write. No user action, and a 0.4.0 config keeps working
because `toolPrefix` was always the field that mattered.

`mcpTracker` stops passing `mcpServers`, keeps `allowedTools: [toolPrefix]`,
and passes `settingSources: ["user", "project"]` so every scope §5 lists can
actually load.

## 5. Settings

The Tracker section lists **what Claude Code already has**, in one list, each
row showing where it comes from:

| Source | Shown as | Prefix |
|---|---|---|
| account connector (`claudeAiMcpEverConnected`) | *linked to your Claude account* | derived per §2 |
| user scope (`~/.claude.json` → `mcpServers`) | *configured in Claude Code* | `mcp__<name>` |
| project scope (`projects[].mcpServers`) | *configured for `<dir>`* | `mcp__<name>` |
| repo (`<repo>/.mcp.json`) | *configured in this repo* | `mcp__<name>` |

The action per row is **Use this**: it writes `toolPrefix` and nothing else.
There is no Import, no copying, and nothing is read out of a definition beyond
its name.

When the list is empty, the screen shows the `claude mcp add` command as it
does today — that case is unchanged and remains the only one needing a command.

**Preset** stays a separate choice (which prompt file to use). It is not
derivable from a connector name: `claude.ai Atlassian` serves both Jira and
Confluence, and only `jira.md` ships. The check added in 0.4.0 — that the
chosen preset resolves to a real prompt file — stays exactly as it is.

## 6. Listing connectors: which source

`claudeAiMcpEverConnected` is a record of what has *ever* connected, not what is
available now, and a connector that has never been used may be missing from it
(`claude.ai Kite mcp` stayed `pending` across every probe).

The authoritative source is a session's `system/init` message, whose
`mcp_servers` array carries each server's `name`, `status` and `source` —
including ones absent from the config file. It costs one short query.

**Decision: 0.5.0 reads the file only. Refresh is deferred.**
Opening Settings must not spend a model call, and the file-derived list is
right in the case this work exists for — the user's `claude.ai Atlassian` is
present in `claudeAiMcpEverConnected`, confirmed on their machine. Adding a
model-call-backed Refresh for a gap nobody has hit would be speculative.

The limitation is real and stated in the UI rather than hidden: a connector
that has never been used may not appear, and the remedy is to use it once in
Claude Code. If someone hits it, Refresh — reading `mcp_servers` from a
session's `system/init` — is the fix, and it is a follow-up, not a gap in this
plan.

## 7. What this removes

- `POST /api/setup/import` and its route, tests and UI path.
- `McpServerFound.definition` — discovery returns names, origins and prefixes.
  Nothing anywhere reads a definition's contents, so no redaction is needed on
  a path that no longer carries anything to redact.
- The "account connectors cannot be imported" explanation, which becomes
  untrue: they are exactly as usable as local ones.

`GET`/`PUT /api/integrations` keep their 0.4.0 redaction. It costs nothing and
protects a `mcpServers` field that a pre-0.5.0 config may still contain.

## 8. Failure handling

- A `toolPrefix` naming a server Claude Code does not have fails at the first
  tracker call with the provider's own error. The **Test** button is the place
  to discover that, and is unchanged.
- A connector that is `pending` is not an error: naming it in `allowedTools` is
  what connects it (§2). Settings does not report pending as a problem.
- Refresh failing leaves the file-derived list in place and reports why.

## 9. Testing

- **Derivation:** the connector-name → prefix rule, including the two verified
  examples and a name with no `claude.ai ` prefix.
- **Discovery:** one list from all four sources, with origins; no definition in
  the output; `claudeAiMcpEverConnected` absent, empty, and containing a
  non-string.
- **Config:** a 0.4.0 config with `mcpServers` loads, is ignored, and is dropped
  on write; `toolPrefix` survives untouched.
- **`mcpTracker`:** passes `allowedTools: [toolPrefix]` and **no** `mcpServers`.
- **UI:** the list renders every source with its origin; **Use this** writes
  only `toolPrefix`; the empty case still shows the command.
- **Live (opt-in, manual):** the §2 probe, re-run against the user's real
  `claude.ai Atlassian` connector before this is called done — §2 is verified
  for `Claude Docs`, not for Atlassian.
- Nothing in CI reads a real `~/.claude` or makes a model call.

## 10. Out of scope

Deriving the preset from a connector; a Confluence or Linear preset; removing a
remembered repo; the pending `bugfix.spec.ts` race; the `setupHome` override
that would stop the server unit suite reading the real `~/.claude`.

## 11. Risks

| Risk | Mitigation |
|---|---|
| §2 was verified with Claude Docs, not Atlassian | §9's live checklist re-runs it against the real connector before this ships |
| A connector missing from `claudeAiMcpEverConnected` is invisible | Refresh reads a session's authoritative `mcp_servers` |
| Claude Code changes the connector prefix convention | The prefix is stored, not recomputed per call; a wrong one fails visibly at Test with the provider's own error |
| Dropping `mcpServers` breaks a user relying on a definition AgentGrid held that Claude Code does not | Verified impossible for account connectors; for local servers the definition lives in Claude Code's own config, which is where the agent reads it from |
