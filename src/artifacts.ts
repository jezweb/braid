// Reads of canonical main through the Artifacts binding (no git, no token).

export type MainRead = { content: string | null; base: string | null };

/** Blob oid at `path` on `ref`, walking trees one level per call; null when absent or not a file. */
export async function blobAtRef(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
  const head = (await repo.log({ ref, limit: 1 }))[0];
  if (!head) return null;
  let tree = head.treeHash;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const entries = await repo.readTree(tree);
    const e = entries?.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.type === "blob" ? e.hash : null;
    if (e.type !== "tree") return null;
    tree = e.hash;
  }
  return null;
}

export async function readMain(artifacts: Artifacts, repoName: string, path: string): Promise<MainRead> {
  using repo = await artifacts.get(repoName);
  const base = await blobAtRef(repo, "main", path);
  if (!base) return { content: null, base: null };
  const blob = await repo.readBlob(base);
  return { content: blob ? await blob.text() : null, base };
}

/** Seconds until an Artifacts token (`art_v1_<secret>?expires=<unix>`) expires; Infinity when it says nothing. */
export function tokenTtl(token: string, now = Date.now()): number {
  const m = /[?&]expires=(\d+)/.exec(token);
  return m ? Number(m[1]) - now / 1000 : Infinity;
}
