/**
 * Env var names that must never reach an agent process — SDK-spawned or the embedded
 * Terminal tab. The server itself is started from a login shell that has forge
 * credentials exported (that's the documented Bitbucket/GitHub CLI setup); nothing
 * downstream of that shell may inherit them. Untrusted ticket text already reaches
 * these agents, so a leaked token here is directly exploitable, not theoretical.
 *
 * Kept as ONE list both `buildOptions` (SDK-spawned agents) and `cleanEnv` (the
 * embedded Terminal's pty) filter through, so the set can't drift between the two.
 */
const FORGE_SECRET_VARS = /^(BITBUCKET_API_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/i;

/** Returns a copy of `base` with every forge-credential env var removed. */
export function stripForgeSecrets(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (FORGE_SECRET_VARS.test(k)) continue;
    env[k] = v;
  }
  return env;
}
