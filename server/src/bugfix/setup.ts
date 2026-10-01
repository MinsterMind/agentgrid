import type { Integrations } from "./integrations.js";
import type { Discovery, McpServerFound } from "./mcp-discovery.js";

export type CheckId = "config-file" | "tracker" | "tracker-server" | "forge" | "forge-username" | "forge-token" | "role";
/**
 * The `action` fix vocabulary: a remedy the user performs *in the UI* rather than a string to
 * copy. A closed union rather than a free `string`, because the UI has to render each one and
 * a free string is the one place server and UI can drift silently — adding a member here is a
 * compile error in `SettingsDialog`'s `Fix` until it is rendered. `use:<toolPrefix>` names the
 * discovered server the tracker check would pick.
 */
export type FixAction = "save" | "reinstall" | "fix-or-remove-config" | `use:${string}`;
export interface Check {
  id: CheckId;
  state: "ok" | "missing" | "broken";
  detail: string;
  fix?: { kind: "command" | "env" | "field"; value: string } | { kind: "action"; value: FixAction };
  /** Does this stop a bug fix from being started at all? Drives the launcher's summary. */
  blocks: boolean;
}
export interface SetupReport {
  ready: boolean;
  wired: boolean;
  checks: Check[];
  // Straight through from the scanner: `McpServerFound` already carries only safe fields (name,
  // toolPrefix, origin), so there is nothing left to strip or reshape here.
  discovery: { servers: McpServerFound[]; problems: string[] };
  addCommand: string;
}

/**
 * The default `claude mcp add` line. An editable default, not a constant to be trusted
 * forever: the previous `…/v1/sse` endpoint stopped being supported after 30 June 2026.
 */
export const DEFAULT_ADD_COMMAND = "claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp";

/**
 * Config + environment + scan → what is wrong and what to do about it.
 *
 * Pure: no I/O, no clock, no `process.env` of its own — everything arrives in `input`, so
 * every state is reachable from a test. The UI renders whatever comes back non-`ok`, which
 * is why the remedies live on the checks rather than in the UI: there is no second list to
 * keep in sync.
 */
export function buildSetupReport(input: {
  cfg: Integrations | null;
  cfgError?: string;
  cfgExists: boolean;
  discovery: Discovery;
  env: NodeJS.ProcessEnv;
  wired: boolean;
  roleResolves: boolean;
  /** Whether `<preset>.md` exists under the tracker presets directory. Undefined (no host
   *  wired one in) is treated as "can't tell, assume fine" — the check degrades to what it
   *  always tested rather than blocking every caller that hasn't been updated. */
  trackerPresetResolves?: (preset: string) => boolean;
}): SetupReport {
  const { cfg, cfgError, cfgExists, discovery, env, wired, roleResolves, trackerPresetResolves } = input;
  const checks: Check[] = [];

  if (cfgError) {
    checks.push({ id: "config-file", state: "broken", blocks: true,
      detail: `~/.agentgrid/integrations.json could not be read: ${cfgError}`,
      fix: { kind: "action", value: "fix-or-remove-config" } });
  } else if (!cfgExists) {
    checks.push({ id: "config-file", state: "missing", blocks: true,
      detail: "~/.agentgrid/integrations.json does not exist yet. Saving here creates it.",
      fix: { kind: "action", value: "save" } });
  } else {
    checks.push({ id: "config-file", state: "ok", blocks: true, detail: "~/.agentgrid/integrations.json is readable." });
  }

  const tracker = cfg?.tracker;
  if (tracker?.toolPrefix) {
    const presetResolves = trackerPresetResolves ? trackerPresetResolves(tracker.preset) : true;
    if (presetResolves) {
      checks.push({ id: "tracker", state: "ok", blocks: true, detail: `Tracker configured (${tracker.preset}, tools ${tracker.toolPrefix}).` });
    } else {
      // The exact failure C1 closes: `toolPrefix` alone used to be enough to report ok, so a
      // preset with no prompt file (an unset default, a typo) sailed through Settings green and
      // only surfaced as an ENOENT the moment a bug fix actually asked the tracker something.
      checks.push({ id: "tracker", state: "broken", blocks: true,
        detail: `Tracker preset "${tracker.preset}" has no prompt file in presets/tracker/ — ` +
          `"${tracker.preset}.md" does not exist there. Set tracker.preset to one that does, e.g. "jira".`,
        fix: { kind: "field", value: "tracker.preset" } });
    }
    // AgentGrid holds no connection of its own — the agent reaches whatever Claude Code has — so
    // the one thing worth saying about the prefix is whether Claude Code has it. Non-blocking:
    // the scan can miss a connector that has never been used (spec §6), and Test settles it.
    // A prefix may also name one tool of a server (`<server>__<tool>`), which still counts.
    const prefix = tracker.toolPrefix;
    const has = discovery.servers.some(s => prefix === s.toolPrefix || prefix.startsWith(`${s.toolPrefix}__`));
    checks.push(has
      ? { id: "tracker-server", state: "ok", blocks: false, detail: `Claude Code has ${prefix}.` }
      : { id: "tracker-server", state: "missing", blocks: false,
          detail: `Claude Code has no MCP server matching ${prefix}, so tracker calls will fail. ` +
            "Connect your tracker in Claude (claude.ai → Settings → Connectors) or in Claude Code, then press Detect " +
            "and pick it below. A connector you have never used may not be listed yet — Test is the check." });
  } else {
    // An account connector needs no definition to be usable — naming its tool prefix in
    // `allowedTools` is what connects it (spec §2) — so it is exactly as usable as a server
    // defined locally. These are the servers Claude Code already has; the user picks one.
    const first = discovery.servers[0];
    checks.push({ id: "tracker", state: "missing", blocks: true,
      detail: first
        ? `No tracker configured. Claude Code already has ${discovery.servers.length} MCP server(s) connected — ` +
          `pick one and set tracker.toolPrefix to it, e.g. "${first.toolPrefix}".`
        : "No tracker configured, and no MCP server was found in your Claude Code configuration.",
      fix: first ? { kind: "action", value: `use:${first.toolPrefix}` } : { kind: "command", value: DEFAULT_ADD_COMMAND } });
  }

  const forge = cfg?.forge;
  if (!forge?.preset) {
    checks.push({ id: "forge", state: "missing", blocks: true,
      detail: "No forge configured. Set forge.preset in ~/.agentgrid/integrations.json to \"github\" or \"bitbucket\" " +
        "— it is the code host AgentGrid opens pull requests against.",
      fix: { kind: "field", value: "forge.preset" } });
  } else {
    checks.push({ id: "forge", state: "ok", blocks: true, detail: `Forge: ${forge.preset}.` });
    if (forge.preset === "bitbucket") {
      const named = typeof forge.username === "string" && forge.username.trim().length > 0;
      checks.push(named
        ? { id: "forge-username", state: "ok", blocks: true, detail: `Bitbucket account: ${forge.username!.trim()}.` }
        : { id: "forge-username", state: "missing", blocks: true,
            detail: "Bitbucket needs your Atlassian account email to authenticate. " +
              "Set forge.username in ~/.agentgrid/integrations.json.",
            fix: { kind: "field", value: "forge.username" } });
      // Presence only — the value is never read into the report.
      checks.push(env.BITBUCKET_API_TOKEN?.trim()
        ? { id: "forge-token", state: "ok", blocks: false, detail: "BITBUCKET_API_TOKEN is visible to the server." }
        : { id: "forge-token", state: "missing", blocks: false,
            detail: "BITBUCKET_API_TOKEN is not visible to the server process. Export it in your login shell, then restart AgentGrid — the app reads that environment when it launches.",
            fix: { kind: "env", value: "BITBUCKET_API_TOKEN" } });
    }
  }

  checks.push(roleResolves
    ? { id: "role", state: "ok", blocks: true, detail: "The bugfix role resolves." }
    : { id: "role", state: "missing", blocks: true,
        detail: "The bugfix role could not be resolved from the app's defaults or ~/.agentgrid/roles.",
        fix: { kind: "action", value: "reinstall" } });

  return {
    // `ready` answers "can a bug fix be started right now?", which is what `wired` means:
    // the engine's existence is what the API guard tests. The checks describe the *config* —
    // what the user edits and what the next boot reads — so they decide only before anything
    // is wired. A config deleted or corrupted under a running server leaves the workflow
    // working, and reporting it unavailable would be false.
    ready: wired || checks.every(c => !c.blocks || c.state === "ok"),
    wired,
    checks,
    // Straight through: no definition ever reaches here to begin with now.
    discovery: { servers: discovery.servers, problems: discovery.problems },
    addCommand: DEFAULT_ADD_COMMAND,
  };
}
