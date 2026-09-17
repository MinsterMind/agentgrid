import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface Prefs { browseRoot?: string; home?: string }

/** Tiny JSON preferences file under Electron's userData (env vars AGENTGRID_* still override at runtime). */
export class PrefsStore {
  private file: string;
  constructor(userData: string) { this.file = path.join(userData, "prefs.json"); }
  read(): Prefs {
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Prefs; } catch { return {}; }
  }
  write(patch: Prefs): Prefs {
    const next = { ...this.read(), ...patch };
    for (const k of Object.keys(next) as (keyof Prefs)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}
