import type { Integrations } from "./integrations.js";
import type { Discovery } from "./mcp-discovery.js";

export type CheckId = "config-file" | "tracker" | "forge" | "forge-username" | "forge-token" | "role";
export interface Check {
  id: CheckId;
  state: "ok" | "missing" | "broken";
  detail: string;
  fix?: { kind: "command" | "env" | "field" | "action"; value: string };
  /** Does this stop a bug fix from being started at all? Drives the launcher's summary. */
  blocks: boolean;
}
export interface SetupReport {
  ready: boolean;
  wired: boolean;
  checks: Check[];
  discovery: { importable: Array<{ name: string; type?: string; url?: string; origin: string; originDetail?: string }>;
               accountOnly: string[]; problems: string[] };
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
}): SetupReport {
  const { cfg, cfgError, cfgExists, discovery, env, wired, roleResolves } = input;
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
    checks.push({ id: "tracker", state: "ok", blocks: true, detail: `Tracker configured (${tracker.preset}, tools ${tracker.toolPrefix}).` });
  } else {
    const first = discovery.importable[0];
    checks.push({ id: "tracker", state: "missing", blocks: true,
      detail: first
        ? `No tracker configured. ${discovery.importable.length} MCP server(s) found in your Claude Code configuration.`
        : discovery.accountOnly.length
          ? `No tracker configured. ${discovery.accountOnly.length} connector(s) are linked to your Claude account, but account connectors keep their definition server-side — there is nothing to import. Add a local one, then press Detect.`
          : "No tracker configured, and no MCP server was found in your Claude Code configuration.",
      fix: first ? { kind: "action", value: `import:${first.name}` } : { kind: "command", value: DEFAULT_ADD_COMMAND } });
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
    ready: checks.every(c => !c.blocks || c.state === "ok"),
    wired,
    checks,
    // Only the shape the UI needs: a definition can carry credentials and never leaves the server.
    discovery: {
      importable: discovery.importable.map(s => ({
        name: s.name,
        ...(typeof s.definition.type === "string" ? { type: s.definition.type } : {}),
        ...(typeof s.definition.url === "string" ? { url: s.definition.url } : {}),
        origin: s.origin,
        ...(s.originDetail ? { originDetail: s.originDetail } : {}),
      })),
      accountOnly: discovery.accountOnly,
      problems: discovery.problems,
    },
    addCommand: DEFAULT_ADD_COMMAND,
  };
}
