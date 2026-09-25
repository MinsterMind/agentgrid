import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

export interface TrackerConfig { preset: string; toolPrefix: string; mcpServers: Record<string, unknown>; hints?: string }
export interface ForgeConfig { preset: "github" | "gitlab" | "custom"; getPr?: string; merge?: string; map?: Record<string, string> }
export interface Integrations { tracker?: TrackerConfig; forge?: ForgeConfig; projectRepos: Record<string, string> }

/** Which forge a git remote belongs to; null means "we can't poll it" (the flow still works, manually). */
export function detectForge(remoteUrl: string | null): "github" | "gitlab" | null {
  if (!remoteUrl) return null;
  const host = remoteUrl.replace(/^[a-z]+:\/\//i, "").replace(/^[^@]+@/, "").split(/[/:]/)[0]?.toLowerCase() ?? "";
  const labels = host.split(".");
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || labels.includes("gitlab")) return "gitlab";
  return null;
}

let seq = 0;
const writeChains = new Map<string, Promise<unknown>>();
/**
 * Serialises every read-merge-write against a given file behind a per-file promise chain, so two
 * concurrent callers can't both read the same base state and silently drop one another's patch.
 * Same atomic write (temp file + rename) the agent store and bug-task store use.
 */
function withWriteChain<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeChains.set(file, next);
  next.finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); }).catch(() => {});
  return next;
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

  /**
   * Merges `patch` (or the result of calling it with the freshly-read current config) onto disk.
   * The read and the write happen inside the same chained turn, so racing writers each see the
   * other's result rather than both merging onto a stale base.
   */
  async write(patch: Partial<Integrations> | ((cur: Integrations) => Partial<Integrations>)): Promise<Integrations> {
    return withWriteChain(this.file, async () => {
      const cur = await this.read();
      const effective = typeof patch === "function" ? patch(cur) : patch;
      const next = { ...cur, ...effective };
      await mkdir(this.home, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${++seq}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2));
      await rename(tmp, this.file);
      return next;
    });
  }

  async rememberRepo(project: string, repo: string): Promise<void> {
    await this.write(cur => ({ projectRepos: { ...cur.projectRepos, [project]: repo } }));
  }
  async repoFor(project: string): Promise<string | undefined> {
    return (await this.read()).projectRepos[project];
  }
}
