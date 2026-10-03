// Runs the G0 spike inside workerd: sets up repos with the git CLI on a local
// server, then POSTs /spike/merge to a running `wrangler dev` (default :8787).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitServer } from "./git-server.mjs";

const dev = process.argv[2] ?? "http://127.0.0.1:8787";
const root = mkdtempSync(join(tmpdir(), "braid-workerd-"));
const { server, port } = await startGitServer({ root });
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
g(root, "init", "-q", "--bare", "-b", "main", "memory.git");
g(root, "clone", "-q", "memory.git", "c");
const c = join(root, "c");
writeFileSync(join(c, "a.md"), "# A\n");
writeFileSync(join(c, "b.md"), "# B\n");
// SCALE=n adds n filler records of ~7 KB each.
const scale = Number(process.env.SCALE ?? 0);
if (scale) execFileSync("mkdir", ["-p", join(c, "k")]);
for (let i = 0; i < scale; i++) writeFileSync(join(c, "k", `r${i}.md`), `# Record ${i}\n\n` + `Lorem ${i} ipsum dolor sit amet. `.repeat(220));
g(c, "add", "-A"); g(c, "commit", "-qm", "seed"); g(c, "push", "-q", "origin", "HEAD:main");
g(root, "clone", "-q", "--bare", "memory.git", "memory--scout.git");
for (const i of [1, 2]) { writeFileSync(join(c, "a.md"), `# A v${i}\n`); g(c, "commit", "-qam", `advance ${i}`); g(c, "push", "-q", "origin", "HEAD:main"); }
g(root, "clone", "-q", "memory--scout.git", "l");
const l = join(root, "l");
const base = g(l, "rev-parse", "HEAD:b.md");
writeFileSync(join(l, "b.md"), "# B, by scout\n");
g(l, "commit", "-qam", `Scout edits B\n\nAgent: scout\nRecord-Path: b.md ${base}`);
g(l, "push", "-q", "origin", "HEAD:main");
const url = (n) => `http://127.0.0.1:${port}/${n}.git`;
const res = await fetch(`${dev}/spike/merge`, { method: "POST", body: JSON.stringify({ canonical: { url: url("memory") }, lane: { url: url("memory--scout") } }) });
const out = await res.json();
console.log(res.status, JSON.stringify(out));
console.log(g(join(root, "memory.git"), "log", "--graph", "--oneline", "main"));
console.log(g(join(root, "memory.git"), "log", "-1", "--format=%B", "main"));
g(join(root, "memory.git"), "fsck", "--strict", "--no-dangling");
console.log("fsck ok");
server.close();
