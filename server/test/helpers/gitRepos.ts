import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const sh = (cwd: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", args, { cwd }, (err, out) => (err ? rej(err) : res(String(out)))));

/** A fresh, throwaway repo with one commit on `main` — for tests that don't need the shared
 *  `repo`/`beforeEach` fixture, e.g. because they build their own branch topology. */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "repo-"));
  await sh(dir, ["init", "-b", "main"]);
  await sh(dir, ["config", "user.email", "t@t"]); await sh(dir, ["config", "user.name", "T"]);
  await writeFile(path.join(dir, "a.txt"), "one\n");
  await sh(dir, ["add", "."]); await sh(dir, ["commit", "-m", "init"]);
  return dir;
}

/** origin's default branch is `main`, frozen at the first commit; `develop` is where the work is —
 *  the shape of the repo that cut a bug branch from "Initial commit" (PULSEAI-414). */
export async function gitflowClone(opts: { developStale?: boolean } = {}): Promise<{ origin: string; clone: string; seed: string }> {
  const seed = await makeRepo();
  await sh(seed, ["checkout", "-q", "-b", "develop"]);
  await writeFile(path.join(seed, "src.txt"), "app\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "PULSEAI-414: fix the null check"]);
  await writeFile(path.join(seed, "src.txt"), "app v2\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "PULSEAI-4140: unrelated"]);
  if (opts.developStale) { await sh(seed, ["checkout", "-q", "main"]); await new Promise(r => setTimeout(r, 1100)); await writeFile(path.join(seed, "m.txt"), "m\n"); await sh(seed, ["add", "."]); await sh(seed, ["commit", "-qm", "main moves on"]); }
  const origin = await mkdtemp(path.join(tmpdir(), "origin-"));
  await sh(origin, ["clone", "-q", "--bare", seed, "."]);
  await sh(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const parent = await mkdtemp(path.join(tmpdir(), "clone-"));
  await sh(parent, ["clone", "-q", origin, "c"]);
  const clone = path.join(parent, "c");
  await sh(clone, ["config", "user.email", "t@t"]); await sh(clone, ["config", "user.name", "T"]);
  return { origin, clone, seed };
}
