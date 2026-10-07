import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { BadRequest, writeAtomic } from "../store/store.js";

/** A built-in tool (`Bash`, `Edit`, …) or an MCP tool (`mcp__server__tool`), optionally with a parenthesised argument. */
const RULE = /^([A-Z][A-Za-z0-9_]*|mcp__[\w-]+)(?:\((.+)\))?$/;
const MULTI = new Set(["npm", "git", "yarn", "pnpm", "docker", "kubectl", "gh", "cargo", "go"]);
/** Flags that take a value before the subcommand: `git -C <dir> push` is `git push`. */
const VALUE_FLAGS = new Set(["-C", "-c", "--prefix", "--git-dir", "--work-tree", "-w", "--workspace", "--dir", "--cwd", "--context", "-n", "--namespace"]);
const BROAD = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** A prefix rule on one of these runs anything at all — as broad as bare Bash. */
const RUNS_ANYTHING = new Set(["bash", "sh", "zsh", "fish", "dash", "python", "python2", "python3", "node", "deno", "bun", "perl", "ruby", "php",
  "env", "sudo", "doas", "xargs", "eval", "exec", "nohup", "timeout", "time", "nice", "npx", "git", "command", "builtin", "source", "."]);

export function isValidRule(rule: string): boolean { return RULE.test(rule.trim()); }
export function isBroadRule(rule: string): boolean {
  const r = rule.trim();
  if (BROAD.has(r)) return true;
  const m = /^Bash\((.+):\*\)$/.exec(r);
  return !!m && RUNS_ANYTHING.has(m[1].trim());
}

/**
 * Parts of a shell command, split on && || ; | and newlines — or null, meaning "never auto-allow, ask".
 * The matcher overrides Claude Code's own prompt for every agent, so anything it can't read as a plain list
 * of commands fails closed: command or process substitution, a lone `&` (a second, backgrounded command),
 * and redirection that writes a file. Redirects to /dev/null or to another descriptor are harmless and kept.
 */
export function splitCommand(cmd: string): string[] | null {
  const c = cmd.replace(/&>\s*\/dev\/null|\d*>>?\s*\/dev\/null|\d*>&\d+|\d*<&\d+/g, " ");
  if (/\$\(|`|<\(|>\(|>/.test(c)) return null;
  if (/&/.test(c.replace(/&&/g, ""))) return null;
  return c.split(/&&|\|\||;|\||\n|\r/).map(p => p.trim()).filter(Boolean);
}

const argOf = (input: Record<string, unknown>): string | null => {
  for (const k of ["file_path", "url", "pattern", "notebook_path", "path"]) if (typeof input[k] === "string") return input[k] as string;
  return null;
};
const hostOf = (url: unknown): string | null => { try { return new URL(String(url)).hostname; } catch { return null; } };

function matchesOne(rule: string, toolName: string, input: Record<string, unknown>, command?: string): boolean {
  const m = RULE.exec(rule.trim());
  if (!m || m[1] !== toolName) return false;
  const content = m[2];
  if (content === undefined) return true;
  if (toolName === "Bash") {
    const cmd = (command ?? String(input.command ?? "")).trim();
    if (content.endsWith(":*")) { const prefix = content.slice(0, -2).trim(); return cmd === prefix || cmd.startsWith(prefix + " "); }
    return cmd === content.trim();
  }
  if (content.startsWith("domain:")) return hostOf(input.url) === content.slice("domain:".length);
  return argOf(input) === content;
}

export function matchesRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  return matchesOne(rule, toolName, input);
}

export function allowedByRules(rules: string[], toolName: string, input: Record<string, unknown>): boolean {
  if (!rules.length) return false;
  if (toolName === "Bash") {
    const parts = splitCommand(String(input.command ?? ""));
    if (!parts || !parts.length) return false;
    return parts.every(p => rules.some(r => matchesOne(r, "Bash", input, p)));
  }
  return rules.some(r => matchesOne(r, toolName, input));
}

/** What "Always allow" saves: Claude Code's own suggestion when it translates, else a sensible default. */
export function suggestRule(toolName: string, input: Record<string, unknown>, suggestions: unknown[]): string {
  for (const s of suggestions as Array<{ type?: string; behavior?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }>) {
    if (s?.type !== "addRules" || (s.behavior && s.behavior !== "allow")) continue;
    const r = s.rules?.find(x => x?.toolName === toolName);
    if (r) { const rule = r.ruleContent ? `${toolName}(${r.ruleContent})` : toolName; if (isValidRule(rule)) return rule; }
  }
  if (toolName === "Bash") {
    const first = splitCommand(String(input.command ?? ""))?.[0] ?? "";
    const words = first.split(/\s+/).filter(Boolean);
    if (!words.length) return "Bash";
    let sub: string | undefined;
    if (MULTI.has(words[0])) {
      // The subcommand is the first word that isn't a flag (or a flag's value): `git -C /r push` → `git push`.
      for (let i = 1; i < words.length; i++) {
        if (words[i].startsWith("-")) { if (VALUE_FLAGS.has(words[i])) i++; continue; }
        sub = words[i]; break;
      }
    }
    return `Bash(${sub ? `${words[0]} ${sub}` : words[0]}:*)`;
  }
  if (toolName === "WebFetch") { const h = hostOf(input.url); if (h) return `WebFetch(domain:${h})`; }
  return toolName;
}

export interface SavedRule { rule: string; addedAt: string }

/** Shared always-allow rules, kept by the server for every agent, bug fix and embedded session. */
export class RulesStore {
  private items: SavedRule[] = [];
  problem: string | null = null;
  private file: string;
  constructor(home: string) { this.file = path.join(home, "permissions.json"); }
  async load(): Promise<void> {
    const raw = await readFile(this.file, "utf8").catch(() => null);
    if (raw === null) { this.items = []; this.problem = null; return; }
    try {
      const allow = JSON.parse(raw)?.allow;
      if (!Array.isArray(allow)) throw new Error("no allow list");
      this.items = allow.filter((x: SavedRule) => typeof x?.rule === "string" && isValidRule(x.rule));
      this.problem = null;
    } catch (e) {
      this.items = []; this.problem = `permissions.json could not be read (${(e as Error).message}); nothing is auto-allowed until it is fixed or a rule is saved`;
    }
  }
  list(): SavedRule[] { return [...this.items]; }
  rules(): string[] { return this.items.map(i => i.rule); }
  async add(rule: string): Promise<SavedRule[]> {
    const r = rule.trim();
    if (!isValidRule(r)) throw new BadRequest(`"${rule}" is not a valid rule`);
    if (!this.items.some(i => i.rule === r)) { this.items.push({ rule: r, addedAt: new Date().toISOString() }); await this.save(); }
    return this.list();
  }
  async remove(rule: string): Promise<SavedRule[]> { this.items = this.items.filter(i => i.rule !== rule); await this.save(); return this.list(); }
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeAtomic(this.file, { allow: this.items });
    this.problem = null;
  }
}
