/**
 * A message safe to log or show in the UI for a `JSON.parse` failure.
 *
 * V8 sometimes embeds a source excerpt in the error (e.g. `..."rization":Bearer sk-"...`) to
 * help debugging — but the files parsed here (`integrations.json`, a Claude Code MCP config)
 * can carry a credential, and that excerpt reaches `discovery.problems` -> `SetupReport` (the
 * rendered list in Settings) or the boot log. Spec §8: a definition's contents are "never
 * logged, never echoed to the UI". Keep only the position/line the parser stopped at, never
 * the surrounding text.
 */
export function describeJsonParseError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const at = msg.match(/at position \d+(?: \(line \d+ column \d+\))?/);
  return at ? `invalid JSON (${at[0]})` : "invalid JSON";
}
