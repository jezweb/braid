// Fold a lane's unmerged commits into canonical main, oldest first, one
// two-parent merge commit each, pushed fast-forward in one push. Built on a
// shallow in-memory store; merge decisions come from the merge table.

import { formatMessage, laneTrailers, parseMessage, type Resolution } from "./contract";
import { mergeRecord, type Conflict } from "./merge";
import { NotTextError, PathCollisionError, PushRejectedError, Store, type Remote } from "./git/store";

/** One conflicted path, with everything a person (or a model) needs to resolve it. */
export type PathConflict = {
  path: string;
  conflicts: Conflict[];
  base: string | null; // blob the writer edited from
  ours: string | null; // main's blob when the conflict was found: an approval applies only while main still holds it
  theirs: string | null; // the writer's blob
  baseText: string | null;
  oursText: string | null;
  theirsText: string | null;
};

/** A person's (or an approved proposal's) answer for one path of one lane commit. */
export type Override = { ours: string | null; content: string | null; resolution: "llm" | "human"; approvedBy: string };

export type LaneOutcome =
  | { status: "merged"; laneCommit: string; mergeCommit: string; resolution: Resolution }
  | { status: "conflict"; laneCommit: string; conflicts: PathConflict[] }
  | { status: "invalid"; laneCommit: string; errors: string[] };

export type MergeLaneResult = {
  mainBefore: string;
  mainAfter: string;
  /** In lane order. Stops at the first commit that is not merged. */
  outcomes: LaneOutcome[];
  /** Lane commits skipped because main already names them, oldest first. */
  skipped: string[];
  storeBytes: number;
  ms: number;
};

export type MergeLaneOptions = {
  /** The last lane commit already folded into main, or the commit the lane forked from. */
  since: string;
  /**
   * The lane's agent. When set, a commit with no braid trailers at all (a plain `git push`) is
   * accepted as that agent's envelope: its paths are the commit's diff against its parent, and
   * each base is the parent's blob. Partial or malformed trailers are still refused.
   */
  agent?: string;
  laneRef?: string;
  /** How much lane history to fetch; a lane further than this behind `since` is an error. */
  depth?: number;
  /** Attempts when main moves between fetch and push (each re-fetches main and re-merges). */
  attempts?: number;
  /** Text of a blob main once held. Default: from the store, deepening canonical once if absent. */
  readBase?: (oid: string) => Promise<string>;
  author?: { name: string; email: string };
  /** Approved answers by lane commit and path. Applied only while main still holds the override's `ours`. */
  overrides?: (laneCommit: string, path: string) => Override | undefined;
  /** Lane commits main already names (Lane-Commit:): never folded twice. */
  onMain?: Set<string>;
};

export async function mergeLane(canonical: Remote, lane: Remote, opts: MergeLaneOptions): Promise<MergeLaneResult> {
  const t0 = Date.now();
  const store = await Store.open();
  const mainBefore = await store.fetch(canonical, "main", 1);
  if (!mainBefore) throw new Error("canonical has no main");
  let mainNow = mainBefore;

  // Lane commits after `since`, oldest first, along the first-parent chain. Each one's parent must
  // be in the store (it is what the commit is diffed against), so deepen until `since` is reached.
  let pending: string[] = [];
  for (const depth of opts.depth ? [opts.depth] : [50, 1000, 20000]) {
    const tip = await store.fetch(lane, opts.laneRef ?? "main", depth);
    if (!tip) throw new Error("lane has no main");
    pending = [];
    let oid: string | undefined = tip;
    while (oid && oid !== opts.since && (await store.has(oid))) {
      pending.unshift(oid);
      oid = (await store.readCommit(oid)).parents[0];
    }
    if (oid === opts.since && (await store.has(oid))) break; // the oldest pending commit is diffed against it
    if (depth === (opts.depth ?? 20000)) throw new Error(`lane history does not reach ${opts.since} within depth ${depth}`);
  }

  // A commit main already names was merged by an earlier run whose bookkeeping was lost.
  const skipped: string[] = [];
  while (pending.length && opts.onMain?.has(pending[0])) skipped.push(pending.shift()!);

  let deepened = false;
  const readBase = opts.readBase ?? (async (oid: string) => {
    if (!(await store.has(oid)) && !deepened) { deepened = true; await store.fetch(canonical, "main", 1000); }
    return store.readText(oid);
  });

  // Main may move between our fetch and our push (another merge landed). The
  // push is compare-and-swap on main's old tip: on rejection, fetch and redo.
  let outcomes: LaneOutcome[] = [];
  let head = mainBefore;
  for (let attempt = 1; ; attempt++) {
    outcomes = [];
    head = mainNow;
    for (const laneCommit of pending) {
      const outcome = await foldOne(store, head, laneCommit, readBase, opts.author, opts.overrides, opts.agent);
      outcomes.push(outcome);
      if (outcome.status !== "merged") break;
      head = outcome.mergeCommit;
    }
    if (head === mainNow) break;
    try {
      await store.push(canonical, head, "main");
      break;
    } catch (e) {
      // A refused push did not land. Any other failure (Artifacts once answered a push under
      // contention with an empty body) may have: read main back before deciding.
      const ambiguous = !(e instanceof PushRejectedError);
      mainNow = (await store.fetch(canonical, "main", ambiguous ? 50 : 1))!;
      if (ambiguous && (await store.onFirstParentChain(mainNow, head))) break;
      if (attempt >= (opts.attempts ?? 3)) throw e;
    }
  }
  return { mainBefore, mainAfter: head, outcomes, skipped, storeBytes: store.fs.bytes(), ms: Date.now() - t0 };
}

async function foldOne(
  store: Store,
  head: string,
  laneCommit: string,
  readBase: (oid: string) => Promise<string>,
  author = { name: "braid-merge", email: "merge@braid.invalid" },
  overrides?: MergeLaneOptions["overrides"],
  agent?: string,
): Promise<LaneOutcome> {
  const c = await store.readCommit(laneCommit);
  if (!c.parents[0]) return { status: "invalid", laneCommit, errors: ["lane commit has no parent"] };
  let parsed = parseMessage(c.message);
  if (parsed.errors.length) return { status: "invalid", laneCommit, errors: parsed.errors };
  // A lane writes as its own agent: a trailer naming anyone else is refused, never believed.
  if (agent && parsed.trailers.agent && parsed.trailers.agent !== agent) {
    return { status: "invalid", laneCommit, errors: [`Agent: ${parsed.trailers.agent} on ${agent}'s lane`] };
  }
  // Bare means no braid trailer of any kind; a partial set (a lone Resolution:, Reverts:, Source:) is refused below.
  const { recordPaths, ...rest } = parsed.trailers;
  const bare = recordPaths.length === 0 && Object.values(rest).every((v) => v === undefined);
  if (bare && agent) {
    // A plain git commit: the diff is the envelope.
    const parentTree = (await store.readCommit(c.parents[0])).tree;
    const paths = await store.changedPaths(parentTree, c.tree);
    const recordPaths = await Promise.all(paths.map(async (path) => ({ path, base: await store.blobAt(c.parents[0], path) })));
    if (recordPaths.length === 0) {
      // An empty plain commit (a checkpoint): fold it as a merge that changes nothing, so the lane moves on.
      const mergeCommit = await store.commit({
        tree: (await store.readCommit(head)).tree,
        parents: [head, laneCommit],
        message: formatMessage(parsed.subject || "(empty commit)", { agent, source: "git push", recordPaths: [], laneCommit, resolution: "clean" }),
        author,
      });
      return { status: "merged", laneCommit, mergeCommit, resolution: "clean" };
    }
    parsed = { ...parsed, trailers: { ...parsed.trailers, agent, source: "git push", recordPaths } };
  }
  const t = laneTrailers(formatMessage(parsed.subject, parsed.trailers, parsed.body));
  if (!t.ok) return { status: "invalid", laneCommit, errors: t.errors };
  const { subject, trailers } = t.parsed;

  // The trailers must account for every path the commit changed: an undeclared change would be
  // left out of main while main records the lane commit as merged.
  const parentTree = (await store.readCommit(c.parents[0])).tree;
  const declared = new Set(trailers.recordPaths.map((r) => r.path));
  const undeclared = (await store.changedPaths(parentTree, c.tree)).filter((p) => !declared.has(p));
  if (undeclared.length) return { status: "invalid", laneCommit, errors: undeclared.map((p) => `changed but not declared: ${p}`) };

  const edits = new Map<string, string | null>();
  const conflicts: PathConflict[] = [];
  let resolution: Resolution = "clean";
  const approvers = new Set<string>();
  try {
    for (const rp of trailers.recordPaths) {
      const mainBlob = await store.blobAt(head, rp.path);
      const laneBlob = await store.blobAt(laneCommit, rp.path);
      if (laneBlob === rp.base) continue; // the writer left it as read: main's stands
      const o = overrides?.(laneCommit, rp.path);
      if (o && o.ours === mainBlob) {
        edits.set(rp.path, o.content === null ? null : await store.writeText(o.content));
        resolution = resolution === "human" || o.resolution === "human" ? "human" : "llm";
        approvers.add(o.approvedBy);
        continue;
      }
      if (mainBlob === rp.base) { edits.set(rp.path, laneBlob); continue; } // main untouched since the writer read it
      if (mainBlob === laneBlob) continue; // already there
      let baseText: string | null = null;
      if (rp.base !== null) {
        try { baseText = await readBase(rp.base); }
        catch { return { status: "invalid", laneCommit, errors: [`base ${rp.base} of ${rp.path} is not a blob main ever held`] }; }
      }
      const r = mergeRecord({
        base: baseText,
        ours: mainBlob === null ? null : await store.readText(mainBlob),
        theirs: laneBlob === null ? null : await store.readText(laneBlob),
      });
      if (r.status === "conflict") {
        conflicts.push({ path: rp.path, conflicts: r.conflicts, base: rp.base, ours: mainBlob, theirs: laneBlob, baseText, oursText: r.ours, theirsText: r.theirs });
        continue;
      }
      if (r.resolution === "field" && resolution === "clean") resolution = "field";
      edits.set(rp.path, r.content === null ? null : await store.writeText(r.content));
    }
    if (conflicts.length) return { status: "conflict", laneCommit, conflicts };
    const tree = await store.editTree((await store.readCommit(head)).tree, edits);
    const mergeCommit = await store.commit({
      tree,
      parents: [head, laneCommit],
      message: formatMessage(subject, { ...trailers, laneCommit, resolution, approvedBy: approvers.size ? [...approvers].join(", ") : undefined }),
      author,
    });
    return { status: "merged", laneCommit, mergeCommit, resolution };
  } catch (e) {
    if (e instanceof PathCollisionError || e instanceof NotTextError) return { status: "invalid", laneCommit, errors: [e.message] };
    throw e;
  }
}
