// Real git repos on a local smart-HTTP server; no mocks.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startGitServer } from "./git-server.mjs";

export function sh(cwd: string, ...args: string[]): string {
  return raw(cwd, ...args).trim();
}

/** git output exactly as printed, for file contents. */
export function raw(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
}

export async function gitWorld() {
  const root = mkdtempSync(join(tmpdir(), "braid-git-"));
  const { server, port } = await startGitServer({ root });
  const url = (name: string) => `http://127.0.0.1:${port}/${name}.git`;
  const bare = (name: string) => join(root, `${name}.git`);
  let n = 0;
  /** A working clone of `name` for setting up history with the git CLI. */
  const work = (name: string) => {
    const dir = join(root, `work-${name}-${n++}`);
    execFileSync("git", ["clone", "-q", bare(name), dir]);
    let fresh = false;
    const write = (path: string, content: string) => {
      // Main may have moved under this clone since its last commit: catch up before editing.
      if (!fresh && sh(dir, "ls-remote", "--heads", "origin", "main")) sh(dir, "pull", "-q", "--ff-only", "origin", "main");
      fresh = true;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    };
    const commit = (message: string) => {
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", message);
      fresh = false;
      sh(dir, "push", "-q", "origin", "HEAD:main");
      return sh(dir, "rev-parse", "HEAD");
    };
    return { dir, write, commit, blob: (path: string) => sh(dir, "rev-parse", `HEAD:${path}`) };
  };
  const createRepo = (name: string) => execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare(name)]);
  const fork = (from: string, to: string) => execFileSync("git", ["clone", "-q", "--bare", bare(from), bare(to)]);
  return { root, url, bare, work, createRepo, fork, close: () => server.close() };
}
