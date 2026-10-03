// history and revert, read from canonical main through the binding. write and
// read live on the Lane (src/do/lane.ts); everything else calls these four.

import { parseMessage, type Envelope, type Resolution } from "./contract";
import { blobAtRef } from "./artifacts";

export type HistoryEntry = {
  commit: string;
  subject: string;
  agent?: string;
  source?: string;
  resolution?: Resolution;
  approvedBy?: string;
  reverts?: string;
  laneCommit?: string;
  at: number;
};

/** Main's commits that changed `path`, newest first. Reads up to `scan` commits of first-parent history. */
export async function history(artifacts: Artifacts, repo: string, path: string, scan = 1000): Promise<HistoryEntry[]> {
  using r = await artifacts.get(repo);
  const out: HistoryEntry[] = [];
  // Page against one commit, not "main": main may move between pages.
  const head = (await r.log({ ref: "main", limit: 1 }))[0]?.hash;
  if (!head) return out;
  for (let offset = 0; offset < scan; offset += 1000) {
    const page = await r.log({ ref: head, limit: Math.min(1000, scan - offset), offset });
    for (const c of page) {
      const { subject, trailers: t } = parseMessage(c.message);
      if (!t.recordPaths.some((rp) => rp.path === path)) continue;
      out.push({ commit: c.hash, subject, agent: t.agent, source: t.source, resolution: t.resolution, approvedBy: t.approvedBy, reverts: t.reverts, laneCommit: t.laneCommit, at: c.committedAt });
    }
    if (page.length < 1000) break;
  }
  return out;
}

/**
 * The envelope that undoes main commit `target` (for one path, or every path it changed).
 * Each change asks for the path as it was before `target`, editing FROM the blob `target`
 * produced. So if main has not touched the path since, it merges clean; if a later edit
 * touched other lines it still merges; if a later edit overlaps, a person decides. An undo
 * never clobbers a later edit, and an undo of an undo restores. One exception by design:
 * last_edited_* in frontmatter follow the later edit (see merge.ts), so they never wait on a person.
 */
export async function revertEnvelope(artifacts: Artifacts, repo: string, agent: string, target: string, path?: string): Promise<Envelope> {
  using r = await artifacts.get(repo);
  const c = await r.readCommit(target);
  if (!c) throw new Error(`no commit ${target}`);
  const { subject, trailers } = parseMessage(c.message);
  const paths = path ? [path] : trailers.recordPaths.map((rp) => rp.path);
  if (!paths.length) throw new Error(`${target} names no record paths`);
  const parent = c.parents[0];
  const changes: Envelope["changes"] = [];
  for (const p of paths) {
    const before = parent ? await blobAtRef(r, parent, p) : null;
    const after = await blobAtRef(r, target, p);
    if (before === after) continue;
    const text = before ? await (await r.readBlob(before))!.text() : null;
    changes.push({ path: p, base: after, content: text });
  }
  if (!changes.length) throw new Error(`${target} did not change ${path ?? "anything"}`);
  return { agent, reason: `Undo: ${subject}`.slice(0, 200), changes, reverts: target };
}
