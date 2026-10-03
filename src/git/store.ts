// A bare in-memory git store: fetch tips shallowly from several remotes, read
// paths, write trees and commits, push fast-forward. Git stores, moves and
// records; merging is done by braid itself (see merge.ts).

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemFS } from "./memfs";

export type Remote = {
  url: string;
  /** Token secret (Artifacts: the part before `?expires=`). Omit for an open local server. */
  token?: string;
};

export type Author = { name: string; email: string; timestamp?: number; timezoneOffset?: number };

export type CommitInfo = {
  oid: string;
  tree: string;
  parents: string[];
  message: string;
  author: Author;
};

const GITDIR = "/store.git";

export class NotTextError extends Error {
  constructor(readonly oid: string) { super(`blob ${oid} is not UTF-8 text`); }
}

/** The remote ref moved since we fetched: fetch again and redo the work. */
export class PushRejectedError extends Error {
  constructor(readonly detail: string) { super(`push rejected: ${detail}`); }
}

/** A path that is a file on one side and a folder on the other. Never resolved by replacing either. */
export class PathCollisionError extends Error {
  constructor(readonly path: string) { super(`path collides with an existing file or folder: ${path}`); }
}

function auth(r: Remote) {
  return r.token ? () => ({ username: "x", password: r.token!.split("?expires=")[0] }) : undefined;
}

export class Store {
  readonly fs = new MemFS();
  readonly gitdir = GITDIR;
  readonly cache = {};
  private remotes = new Map<string, string>();

  private remoteName(url: string): string {
    if (!this.remotes.has(url)) this.remotes.set(url, `r${this.remotes.size}`);
    return this.remotes.get(url)!;
  }

  static async open(): Promise<Store> {
    const s = new Store();
    await git.init({ fs: s.fs, gitdir: GITDIR, bare: true, defaultBranch: "main" });
    return s;
  }

  private get base() {
    return { fs: this.fs, gitdir: this.gitdir, cache: this.cache };
  }

  /** Fetch one ref's tip (and `depth` commits of history) into the store. Returns its oid, or null if the ref is absent. */
  async fetch(remote: Remote, ref = "main", depth = 1): Promise<string | null> {
    const name = this.remoteName(remote.url);
    await git.addRemote({ ...this.base, remote: name, url: remote.url, force: true });
    const res = await git.fetch({
      ...this.base,
      http,
      remote: name,
      ref,
      singleBranch: true,
      depth,
      tags: false,
      onAuth: auth(remote),
    });
    return res.fetchHead ?? null;
  }

  async has(oid: string): Promise<boolean> {
    try { await git.readObject({ ...this.base, oid, format: "deflated" }); return true; } catch { return false; }
  }

  /** Whether `oid` is `tip` or on its first-parent chain, as far as the store holds history. */
  async onFirstParentChain(tip: string, oid: string, limit = 200): Promise<boolean> {
    let cur: string | undefined = tip;
    for (let i = 0; cur && i < limit; i++) {
      if (cur === oid) return true;
      if (!(await this.has(cur))) return false;
      cur = (await this.readCommit(cur)).parents[0];
    }
    return false;
  }

  async readCommit(oid: string): Promise<CommitInfo> {
    const { commit } = await git.readCommit({ ...this.base, oid });
    return { oid, tree: commit.tree, parents: commit.parent, message: commit.message, author: commit.author };
  }

  /** Blob oid at `path` in a commit's tree, or null when absent. */
  async blobAt(commitOid: string, path: string): Promise<string | null> {
    let tree = (await this.readCommit(commitOid)).tree;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const { tree: entries } = await git.readTree({ ...this.base, oid: tree });
      const e = entries.find((x) => x.path === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e.type === "blob" ? e.oid : null;
      if (e.type !== "tree") return null;
      tree = e.oid;
    }
    return null;
  }

  async readText(blobOid: string): Promise<string> {
    const { blob } = await git.readBlob({ ...this.base, oid: blobOid });
    // Records are UTF-8 text. Keep a BOM (so bytes round-trip) and refuse anything that is not UTF-8.
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob);
    } catch {
      throw new NotTextError(blobOid);
    }
  }

  async writeText(content: string): Promise<string> {
    return git.writeBlob({ ...this.base, blob: new TextEncoder().encode(content) });
  }

  /** New tree: `baseTree` with each path set to a blob oid, or removed when null. Empty dirs are pruned. */
  async editTree(baseTree: string | null, edits: Map<string, string | null>): Promise<string> {
    type Node = { blobs: Map<string, string | null>; dirs: Map<string, Node> };
    const root: Node = { blobs: new Map(), dirs: new Map() };
    for (const [path, oid] of edits) {
      const parts = path.split("/");
      let n = root;
      for (const p of parts.slice(0, -1)) {
        if (!n.dirs.has(p)) n.dirs.set(p, { blobs: new Map(), dirs: new Map() });
        n = n.dirs.get(p)!;
      }
      n.blobs.set(parts[parts.length - 1], oid);
    }
    const write = async (treeOid: string | null, n: Node): Promise<string | null> => {
      const entries = treeOid ? (await git.readTree({ ...this.base, oid: treeOid })).tree : [];
      const out = new Map(entries.map((e) => [e.path, e]));
      for (const [name, sub] of n.dirs) {
        const cur = out.get(name);
        if (cur && cur.type !== "tree") throw new PathCollisionError(name);
        const oid = await write(cur?.oid ?? null, sub);
        if (oid) out.set(name, { mode: "040000", path: name, oid, type: "tree" });
        else out.delete(name);
      }
      for (const [name, oid] of n.blobs) {
        if (out.get(name)?.type === "tree" || n.dirs.has(name)) throw new PathCollisionError(name);
        if (oid) out.set(name, { mode: "100644", path: name, oid, type: "blob" });
        else out.delete(name);
      }
      if (out.size === 0) return null;
      return git.writeTree({ ...this.base, tree: [...out.values()] });
    };
    return (await write(baseTree, root)) ?? (await git.writeTree({ ...this.base, tree: [] }));
  }

  /** Paths whose blob differs between two trees (either may be null = empty). Folders are walked; type changes count. */
  async changedPaths(a: string | null, b: string | null, prefix = ""): Promise<string[]> {
    if (a === b) return [];
    const read = async (t: string | null) => new Map((t ? (await git.readTree({ ...this.base, oid: t })).tree : []).map((e) => [e.path, e]));
    const [ea, eb] = await Promise.all([read(a), read(b)]);
    const out: string[] = [];
    for (const name of new Set([...ea.keys(), ...eb.keys()])) {
      const x = ea.get(name), y = eb.get(name);
      if (x?.oid === y?.oid && x?.type === y?.type) continue;
      const path = prefix + name;
      const xt = x?.type === "tree" ? x.oid : null, yt = y?.type === "tree" ? y.oid : null;
      if ((x && x.type !== "tree") || (y && y.type !== "tree")) out.push(path);
      if (xt || yt) out.push(...(await this.changedPaths(xt, yt, path + "/")));
    }
    return [...new Set(out)].sort();
  }

  async commit(c: { tree: string; parents: string[]; message: string; author: Author }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const who = { timestamp: now, timezoneOffset: 0, ...c.author };
    return git.writeCommit({
      ...this.base,
      commit: { tree: c.tree, parent: c.parents, message: c.message, author: who, committer: who },
    });
  }

  /** Push `oid` to `ref` on the remote, fast-forward only. Throws PushRejectedError when the remote moved. */
  async push(remote: Remote, oid: string, ref = "main"): Promise<void> {
    const local = `refs/heads/braid-push-${ref}`;
    await git.writeRef({ ...this.base, ref: local, value: oid, force: true });
    let res;
    try {
      res = await git.push({
        ...this.base,
        http,
        url: remote.url,
        ref: local,
        remoteRef: `refs/heads/${ref}`,
        onAuth: auth(remote),
      });
    } catch (e) {
      // Client-side refusal (isomorphic-git saw main move) or the server's: Artifacts answers a
      // stale old-tip with "stale ref" (measured 3 Oct 2026, ten concurrent rounds).
      const code = (e as { code?: string }).code;
      if (code === "PushRejectedError") throw new PushRejectedError(String(e));
      if (code === "GitPushError" && /stale ref|non-fast-forward|fetch first|failed to lock/i.test(String(e))) throw new PushRejectedError(String(e));
      throw e;
    }
    // Trust the per-ref status, not only the overall flag.
    const r = res.refs?.[`refs/heads/${ref}`];
    if (!res.ok || !r?.ok) throw new PushRejectedError(JSON.stringify(res.refs));
  }
}
