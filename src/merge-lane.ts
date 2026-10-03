// Fold a lane's unmerged commits into canonical main, oldest first, one
// two-parent merge commit each, pushed fast-forward in one push. Built on a
// shallow in-memory store; merge decisions come from the merge table.

import { formatMessage, laneTrailers, type Resolution } from "./contract";
import { mergeRecord, type Conflict } from "./merge";
import { NotTextError, PathCollisionError, Store, type Remote } from "./git/store";

export type LaneOutcome =
  | { status: "merged"; laneCommit: string; mergeCommit: string; resolution: Resolution }
  | { status: "conflict"; laneCommit: string; conflicts: { path: string; conflicts: Conflict[] }[] }
  | { status: "invalid"; laneCommit: string; errors: string[] };

export type MergeLaneResult = {
  mainBefore: string;
  mainAfter: string;
  /** In lane order. Stops at the first commit that is not merged. */
  outcomes: LaneOutcome[];
  storeBytes: number;
  ms: number;
};

export type MergeLaneOptions = {
  /** The last lane commit already folded into main, or the commit the lane forked from. */
  since: string;
  laneRef?: string;
  /** How much lane history to fetch; a lane further than this behind `since` is an error. */
  depth?: number;
  /** Text of a blob main once held. Default: from the store, deepening canonical once if absent. */
  readBase?: (oid: string) => Promise<string>;
  author?: { name: string; email: string };
};

export async function mergeLane(canonical: Remote, lane: Remote, opts: MergeLaneOptions): Promise<MergeLaneResult> {
  const t0 = Date.now();
  const store = await Store.open();
  const mainBefore = await store.fetch(canonical, "main", 1);
  const tip = await store.fetch(lane, opts.laneRef ?? "main", opts.depth ?? 50);
  if (!mainBefore || !tip) throw new Error(`missing tip: main=${mainBefore} lane=${tip}`);

  // Lane commits after `since`, oldest first, along the first-parent chain.
  const pending: string[] = [];
  for (let oid = tip; oid !== opts.since; ) {
    pending.unshift(oid);
    const c = await store.readCommit(oid).catch(() => null);
    const parent = c?.parents[0];
    if (!c || !parent || !(await store.has(parent))) {
      if (parent === opts.since) break;
      throw new Error(`lane history does not reach ${opts.since} within depth ${opts.depth ?? 50}`);
    }
    oid = parent;
  }

  let deepened = false;
  const readBase = opts.readBase ?? (async (oid: string) => {
    if (!(await store.has(oid)) && !deepened) { deepened = true; await store.fetch(canonical, "main", 1000); }
    return store.readText(oid);
  });

  const outcomes: LaneOutcome[] = [];
  let head = mainBefore;
  for (const laneCommit of pending) {
    const outcome = await foldOne(store, head, laneCommit, readBase, opts.author);
    outcomes.push(outcome);
    if (outcome.status !== "merged") break;
    head = outcome.mergeCommit;
  }
  if (head !== mainBefore) await store.push(canonical, head, "main");
  return { mainBefore, mainAfter: head, outcomes, storeBytes: store.fs.bytes(), ms: Date.now() - t0 };
}

async function foldOne(
  store: Store,
  head: string,
  laneCommit: string,
  readBase: (oid: string) => Promise<string>,
  author = { name: "braid-merge", email: "merge@braid.invalid" },
): Promise<LaneOutcome> {
  const c = await store.readCommit(laneCommit);
  const t = laneTrailers(c.message);
  if (!t.ok) return { status: "invalid", laneCommit, errors: t.errors };
  const { subject, trailers } = t.parsed;

  const edits = new Map<string, string | null>();
  const conflicts: { path: string; conflicts: Conflict[] }[] = [];
  let resolution: Resolution = "clean";
  try {
    for (const rp of trailers.recordPaths) {
      const mainBlob = await store.blobAt(head, rp.path);
      const laneBlob = await store.blobAt(laneCommit, rp.path);
      if (mainBlob === rp.base) { edits.set(rp.path, laneBlob); continue; } // main untouched since the writer read it
      if (mainBlob === laneBlob) continue; // already there
      const r = mergeRecord({
        base: rp.base === null ? null : await readBase(rp.base),
        ours: mainBlob === null ? null : await store.readText(mainBlob),
        theirs: laneBlob === null ? null : await store.readText(laneBlob),
      });
      if (r.status === "conflict") { conflicts.push({ path: rp.path, conflicts: r.conflicts }); continue; }
      if (r.resolution === "field") resolution = "field";
      edits.set(rp.path, r.content === null ? null : await store.writeText(r.content));
    }
    if (conflicts.length) return { status: "conflict", laneCommit, conflicts };
    const tree = await store.editTree((await store.readCommit(head)).tree, edits);
    const mergeCommit = await store.commit({
      tree,
      parents: [head, laneCommit],
      message: formatMessage(subject, { ...trailers, laneCommit, resolution }),
      author,
    });
    return { status: "merged", laneCommit, mergeCommit, resolution };
  } catch (e) {
    if (e instanceof PathCollisionError || e instanceof NotTextError) return { status: "invalid", laneCommit, errors: [e.message] };
    throw e;
  }
}
