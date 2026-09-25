import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface TrackerConfig { preset: string; toolPrefix: string; mcpServers: Record<string, unknown>; hints?: string }
export interface ForgeConfig { preset: "github" | "gitlab" | "custom"; getPr?: string; merge?: string; map?: Record<string, string> }
export interface Integrations { tracker?: TrackerConfig; forge?: ForgeConfig; projectRepos: Record<string, string> }

/** Which forge a git remote belongs to; null means "we can't poll it" (the flow still works, manually). */
export function detectForge(remoteUrl: string | null): "github" | "gitlab" | null {
  if (!remoteUrl) return null;
  const host = remoteUrl.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").split(/[/:]/)[0]?.toLowerCase() ?? "";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.includes("gitlab")) return "gitlab";
  return null;
}

/** `~/.agentgrid/integrations.json` — tracker/forge providers and the project→repo memory. */
export class IntegrationsStore {
  private file: string;
  constructor(private home: string) { this.file = path.join(home, "integrations.json"); }

  async read(): Promise<Integrations> {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    let parsed: Partial<Integrations> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    return { ...parsed, projectRepos: parsed.projectRepos ?? {} };
  }

  async write(patch: Partial<Integrations>): Promise<Integrations> {
    const next = { ...(await this.read()), ...patch };
    await mkdir(this.home, { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2));
    return next;
  }

  async rememberRepo(project: string, repo: string): Promise<void> {
    const cur = await this.read();
    await this.write({ projectRepos: { ...cur.projectRepos, [project]: repo } });
  }
  async repoFor(project: string): Promise<string | undefined> {
    return (await this.read()).projectRepos[project];
  }
}
