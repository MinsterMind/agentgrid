# Bitbucket Cloud Support and the Settings Screen — Design Spec

**Date:** 2026-09-29
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-25-bugfix-workflow-design.md` (Phase 1) and `2026-09-26-bugfix-phase2-design.md` (Phase 2), shipped in AgentGrid 0.1.5 and 0.2.0

## 1. Problem

The bug-fix workflow works end to end, and cannot be used by the person who asked for it. Two reasons:

1. **Only GitHub has a forge adapter.** `makeForge` returns an adapter for `preset: "github"` and `null` for everything else, and Phase 2's `intake` refuses a repo whose forge is null — a deliberate ruling that withdrew Phase 1's promise of a hand-driven fallback. A Bitbucket Cloud user cannot start a task at all.
2. **There is no way to configure it from the app.** The tracker and forge live in `~/.agentgrid/integrations.json`, a file with no UI, no discovery and no validation. Getting it wrong produces `the bug-fix workflow is not configured` — a 501 that names neither the file nor the missing key. Phase 1's spec listed a Settings screen; neither phase built it.

Both were known. Together they mean the feature ships unusable for this user.

## 2. Goal

Run the whole workflow against Bitbucket Cloud, and make the thing configurable from inside the app — including telling the user exactly what to run when a prerequisite is missing, rather than failing opaquely.

## 3. Decisions (from brainstorming, 2026-09-29)

1. **The forge is server-side HTTP, not MCP.** The user has a Bitbucket MCP server configured, and it cannot serve this: the watcher polls every 30s–5min per task, so MCP would spend tokens on every poll, and it would make the PR's state something an agent reports rather than something the server verified. This restates Phase 1 decision 3 for a case that now looks tempting.
2. **Auth is HTTP Basic with the token from the environment.** `BITBUCKET_API_TOKEN` is read at call time; the Atlassian email is config. **AgentGrid stores no Bitbucket secret.** The desktop app already imports the login shell's environment (`desktop/src/shell-env.ts`), so this works for both the packaged app and `npm run serve`.
3. **The server creates the pull request, for both forges.** `createPrCommand` returned a shell command for the agent to run, which only made sense because `gh` holds its own credentials. Bitbucket has no CLI, so the alternative was handing the agent a token. The server now creates PRs everywhere.
4. **Settings instructs rather than discovers.** Account-level (`claude.ai config`) MCP connectors expose no copyable definition — verified: `claude mcp get` returns status only, and `~/.claude.json` has no `mcpServers` entry for them. So Settings shows the `claude mcp add` command for a *locally scoped* server, then detects and copies that definition. Pasting a definition by hand remains an escape hatch.
5. **Configuration changes take effect on restart**, stated in the UI. Hot-reload would rebuild the engine and watcher under in-flight tasks whose dispatch state is in memory.
6. **Settings shows the command; it does not run it.** Adding an MCP server writes to the user's Claude Code configuration, which should be an act they took.

## 4. The Bitbucket adapter

`server/src/bugfix/forge/bitbucket.ts`, implementing the same `ForgeAdapter` as GitHub, against `https://api.bitbucket.org/2.0/repositories/{workspace}/{slug}`.

### 4.1 Auth and identity

HTTP Basic: `Authorization: Basic base64(email + ":" + BITBUCKET_API_TOKEN)`, over `fetch` — no subprocess. The token is read per call, never stored, never logged, never placed in anything an agent can read.

`authStatus()` distinguishes three states the Settings screen renders differently:

| State | Message |
|---|---|
| no `BITBUCKET_API_TOKEN` in the environment | names the variable and that a server restart is needed after exporting it |
| token present, rejected (401/403) | says the token was refused, not that the forge is down |
| authenticated | names the account (`GET /2.0/user`), so a wrong account is visible |

The workspace and slug come from the repo's `origin` remote, which is SSH for this user (`git@bitbucket.org:workspace/slug.git`) — parsed for both SSH and HTTPS forms.

### 4.2 The six methods

| Method | Endpoint |
|---|---|
| `findPr(repoDir, branch)` | `GET /pullrequests?q=source.branch.name="<branch>"`, open first, then any state |
| `getPr(repoDir, id)` | `GET /pullrequests/{id}` → three-state `PrLookup` |
| `listReviewEvents(repoDir, id, since)` | `GET /pullrequests/{id}/activity`, oldest first, strictly after `since` |
| `merge(repoDir, id, method)` | `POST /pullrequests/{id}/merge` |
| `createPr(repoDir, ctx)` | `POST /pullrequests` (see §5) |
| `authStatus()` | `GET /2.0/user` |

### 4.3 The three foldings

Bitbucket does not model review state the way the stage machine expects. Each folding is where a defect would hide, so each is stated as a rule:

1. **Review decision.** There is no `reviewDecision`. Bitbucket has per-reviewer `approved` / `changes_requested` on `participants` and in the activity feed. The adapter folds them: **any outstanding "changes requested" wins over any number of approvals.** The alternative merges over an unresolved objection.
2. **Conflicts.** The PR object has no `mergeable` field. Use `GET /pullrequests/{id}/conflicts`. Atlassian has signalled this area is in flux (the `diffstat` "merge conflict" status is documented as going away, with a new public conflict API to follow), so conflict detection is one function with a documented fallback: `git merge-tree` against the fetched base, which the server can answer locally for any forge.
3. **Checks.** Commit statuses, `GET /commit/{sha}/statuses`, folded by the same fail-closed rule as GitHub: anything unrecognised reads as pending, never as success.

`isBot` comes from the account type where Bitbucket reports one; where it does not, the adapter says so rather than guessing, and the engine's existing rule holds — bot events never start a round.

### 4.4 Merge methods

`squash` → `squash`, `merge` → `merge_commit`. Bitbucket's third strategy is `fast_forward`, which is **not** a rebase: `rebase` is **rejected** with a clear message rather than silently performing a different operation. The Settings screen omits it when the forge is Bitbucket.

`close_source_branch: true` handles the remote-branch cleanup that Phase 2 had to move out of the GitHub merge call.

## 5. Server-side pull request creation

### 5.1 The stage split

```
diff-review ──approve──▶ opening-pr   (agent: write pr-body.md and summarise — no outward action)
                          ─verified─▶ creating-pr   (server: push the branch, POST the PR, confirm)
                          ──────────▶ monitoring
```

`creating-pr` joins `pushing` and `merging` in `SERVER_STAGES`, inheriting retry, failure handling and crash recovery. A failed creation is an ordinary retryable stage failure.

### 5.2 What this changes beyond Bitbucket

- **No credential reaches an agent.** The reason for the choice.
- **The first push gets the approved-commit pin.** Today the original push happens inside `gh pr create`, making it the one push in the system that never re-checks `approvedHead`; every feedback-round push is checked. Folding it into a server stage closes that.
- **`renderStagePrompt`'s `createPrCommand` guard becomes obsolete**, along with the preset instruction that made it necessary.

### 5.3 The interface change

`createPrCommand(ctx: CreatePrContext): string` becomes `createPr(repoDir: string, ctx: CreatePrContext): Promise<PrLookup>`. The command-string return was GitHub's CLI leaking into the abstraction; it only became visible when a second forge had to satisfy it.

### 5.4 Risk

This changes a shipped, working path. The GitHub adapter's `createPr` is new code, and `opening-pr` behaves differently. The offline harness and the browser e2e both cover the path and must be green on GitHub before any Bitbucket testing, so a failure is unambiguous about which forge broke.

## 6. The Settings screen

`ui/src/components/SettingsDialog.tsx`, reached from the top bar, following the existing dialog pattern. Three sections.

### 6.1 Tracker

State is shown honestly: *not configured*, *configured but unreachable*, or *connected*.

When there is nothing usable, the screen shows a copyable command:

```
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
```

then "authenticate it in Claude Code (`/mcp` → atlassian)", then:

- **Detect** — reads the local MCP configuration, finds the named server, copies its definition into AgentGrid's config and derives `toolPrefix` from the server name.
- **Test** — runs a real `listMyIssues` and reports the issue count or the actual error.
- **Paste a definition** — the escape hatch when a setup does not match.

The endpoint above is current as of this date: the previous `…/v1/sse` endpoint stopped being supported after 30 June 2026. The command is a default the user can edit, not a constant to be trusted forever.

### 6.2 Forge

`github` or `bitbucket`. Bitbucket collects the Atlassian email and reports whether `BITBUCKET_API_TOKEN` is visible to the **server process** — which is the diagnostic that matters, since the desktop app gets the environment through the login-shell import. **Test** calls `authStatus` and names the account.

### 6.3 Remembered repos

The project→repo map, with a clear action per row. Read-only otherwise.

### 6.4 Saving

Writes through the existing `PUT /api/integrations`, whose `forge.preset` validation gains `"bitbucket"`. A save shows that a server restart is required.

## 7. Failure handling

- The forge unreachable remains *no information*: `PrLookup`'s third state, no stage change, unchanged from Phase 2.
- A missing `BITBUCKET_API_TOKEN` fails `authStatus` and `preflight` with a message naming the variable — never a 500, never a silent empty result.
- `createPr` failing fails the `creating-pr` stage with the forge's own message; retry re-runs it, and a PR that already exists for the branch is adopted rather than duplicated.
- Bitbucket rate limiting (429) is treated as `unavailable`, not as "no PR".

## 8. Security

- The token is read from the environment at call time, never persisted by AgentGrid, never logged, and never placed in a prompt, a command string, or an agent's environment.
- No agent performs an authenticated forge call after this change: push, PR creation and merge are all server work.
- Settings never collects a secret. The one credential it discusses is one the user exports themselves.
- Reading the local MCP configuration is read-only and limited to server definitions.

## 9. Testing

- **Unit:** the three foldings against recorded Bitbucket JSON fixtures — changes-requested outstanding beside approvals, conflicts, commit statuses, and a 429; the workspace/slug parse for SSH and HTTPS remotes; merge-method mapping including the rejected `rebase`.
- **Adapter parity:** both adapters run against the same contract tests, so a future forge has a checklist rather than a reading exercise.
- **Integration (offline):** the existing harness extended so `creating-pr` is exercised for both forges.
- **Real git:** unchanged, plus the `git merge-tree` conflict fallback.
- **UI:** each Settings state — nothing configured, command shown, detected, tested, token missing.
- **E2E:** the existing walk, unchanged in shape, must stay green on GitHub.
- **Live (opt-in, manual):** a documented first-run checklist against the user's real Bitbucket workspace. Nothing in CI touches a live forge.

## 10. Out of scope

GitLab; Bitbucket Server/Data Center (a different API); hot-reloading configuration; running `claude mcp add` on the user's behalf; storing the token in the OS keychain (a later hardening); auto-merge, which remains disabled in the launcher.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Server-side PR creation regresses the working GitHub path | Offline harness and e2e must be green on GitHub before Bitbucket testing |
| Bitbucket's conflict API is in flux | One function, with a local `git merge-tree` fallback |
| Review-state folding is subtle and forge-specific | Stated as an explicit rule, fixture-tested both ways |
| The `claude mcp add` command drifts (as the SSE endpoint already did) | Shown as an editable default; Detect and Test verify reality rather than trusting it |
| The token is absent in the packaged app's environment | `authStatus` names the variable; Settings shows it before a task is ever launched |
