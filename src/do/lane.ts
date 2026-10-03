// One Lane per agent: the only writer of fork `<repo>--<agent>`. Writes run one
// at a time; each envelope becomes one lane commit. The agent's own pending
// (unmerged) writes are kept so its reads see them first.
//
// The push to Artifacts and the bookkeeping in storage cannot be one atomic
// step, so the lane's own commits are the record: on first use after a restart
// the object replays any lane commits it has not recorded (their trailers say
// what they wrote, and Write-Id says which request they answered).

import { DurableObject } from "cloudflare:workers";
import { EnvelopeError, laneMessage, laneTrailers, validateEnvelope, type Envelope } from "../contract";
import { readMain, tokenTtl, type MainRead } from "../artifacts";
import { PathCollisionError, PushRejectedError, Store, type Remote } from "../git/store";
import type { LaneInfo, MergeAgent } from "./merge-agent";

type Env = { ARTIFACTS: Artifacts; LANE: DurableObjectNamespace<Lane>; MERGE_AGENT: DurableObjectNamespace<MergeAgent> };

type Pending = { blob: string | null; content: string | null; laneCommit: string };

export type WriteResult = { laneCommit: string; seq: number; repeated?: boolean };

// Storage keys. Paths and write ids are values inside keys, never object properties.
const PENDING = "pending:"; // pending:<path> -> Pending
const WRITE = "write:"; // write:<id> -> WriteResult
const MERGED = "merged:"; // merged:<laneCommit> -> true (merge acknowledged before its write finished recording)

/** Storage accepts at most 128 pairs per put. Entries first in chunks, then the checkpoint keys in one put. */
async function putAll(storage: DurableObjectStorage, entries: Record<string, unknown>, checkpoint: Record<string, unknown>) {
  const pairs = Object.entries(entries);
  for (let i = 0; i < pairs.length; i += 100) await storage.put(Object.fromEntries(pairs.slice(i, i + 100)));
  await storage.put(checkpoint);
}

export class Lane extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  private info?: LaneInfo & { repo: string; agent: string };
  private store?: Store;
  private tip?: string;

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * A Lane serves exactly one agent of one repo: the object addressed by idFromName("<repo>:<agent>").
   * Any other object refuses, so two objects can never write one fork.
   */
  private pin(repo: string, agent: string) {
    if (!this.ctx.id.equals(this.env.LANE.idFromName(`${repo}:${agent}`))) {
      throw new EnvelopeError(`this lane is not ${repo}:${agent}`);
    }
  }

  private async lane(repo: string, agent: string) {
    if (this.info && tokenTtl(this.info.token) > 300) return this.info;
    const ma = this.env.MERGE_AGENT.get(this.env.MERGE_AGENT.idFromName(repo));
    const got = await ma.provisionLane(repo, agent);
    this.info = { ...got, repo, agent };
    if (!(await this.ctx.storage.get<string>("lastCommit"))) await this.ctx.storage.put("lastCommit", got.forkPoint);
    return this.info;
  }

  /** Load the lane tip; replay lane commits pushed after the last one recorded. */
  private async load(remote: Remote) {
    const s = await Store.open();
    const last = (await this.ctx.storage.get<string>("lastCommit"))!;
    let tip = "";
    let missed: string[] = [];
    // Deepen until the recorded commit is in reach; a long run of unrecorded commits is rare but not fatal.
    for (const depth of [50, 1000, 20000]) {
      tip = (await s.fetch(remote, "main", depth))!;
      missed = [];
      let oid: string | undefined = tip;
      while (oid && oid !== last && (await s.has(oid))) {
        missed.unshift(oid);
        oid = (await s.readCommit(oid)).parents[0];
      }
      if (oid === last) break;
      if (depth === 20000) throw new Error(`lane tip ${tip} does not lead back to recorded ${last}`);
    }
    if (missed.length) {
      let seq = (await this.ctx.storage.get<number>("seq")) ?? 0;
      for (const oid of missed) {
        const t = laneTrailers((await s.readCommit(oid)).message);
        seq++;
        const entries: Record<string, unknown> = {};
        if (t.ok) {
          for (const rp of t.parsed.trailers.recordPaths) {
            const blob = await s.blobAt(oid, rp.path);
            entries[PENDING + rp.path] = { blob, content: blob ? await s.readText(blob) : null, laneCommit: oid } satisfies Pending;
          }
          if (t.parsed.trailers.writeId) entries[WRITE + t.parsed.trailers.writeId] = { laneCommit: oid, seq } satisfies WriteResult;
        }
        await putAll(this.ctx.storage, entries, { seq, lastCommit: oid });
      }
    }
    // Acks that arrived before their write was recorded, or before a restart cut a cleanup short.
    for (const key of (await this.ctx.storage.list({ prefix: MERGED })).keys()) await this.clearIfMerged(key.slice(MERGED.length));
    this.store = s;
    this.tip = tip;
  }

  private async ready(repo: string, agent: string): Promise<Remote> {
    this.pin(repo, agent);
    const info = await this.lane(repo, agent);
    const remote = { url: info.remote, token: info.token };
    if (!this.store || !this.tip) await this.load(remote);
    return remote;
  }

  /** One envelope, one lane commit. A repeated `id` returns the first result. Throws EnvelopeError for a bad envelope. */
  write(repo: string, e: Envelope): Promise<WriteResult> {
    return this.serial(async () => {
      validateEnvelope(e);
      const remote = await this.ready(repo, e.agent);
      if (e.id) {
        const done = await this.ctx.storage.get<WriteResult>(WRITE + e.id);
        if (done) {
          await this.notifyMerge(repo, e.agent); // the first attempt may have stopped before telling the merger
          return { ...done, repeated: true };
        }
      }
      for (let attempt = 1; ; attempt++) {
        const s = this.store!;
        const edits = new Map<string, string | null>();
        for (const c of e.changes) edits.set(c.path, c.content === null ? null : await s.writeText(c.content));
        let tree: string;
        try {
          tree = await s.editTree((await s.readCommit(this.tip!)).tree, edits);
        } catch (err) {
          if (err instanceof PathCollisionError) throw new EnvelopeError(err.message);
          throw err;
        }
        const laneCommit = await s.commit({
          tree,
          parents: [this.tip!],
          message: laneMessage(e),
          author: { name: e.agent, email: `${e.agent}@braid.invalid` },
        });
        try {
          await s.push(remote, laneCommit, "main");
        } catch (err) {
          // The push may have landed (an ambiguous failure) or the cached tip may be stale. Reload:
          // replay records whatever landed, including this write if it did.
          this.store = undefined;
          await this.load(remote);
          if (e.id) {
            const done = await this.ctx.storage.get<WriteResult>(WRITE + e.id);
            if (done) { await this.notifyMerge(repo, e.agent); return done; }
          }
          if (this.tip === laneCommit) {
            await this.notifyMerge(repo, e.agent);
            return { laneCommit, seq: (await this.ctx.storage.get<number>("seq"))! };
          }
          if (err instanceof PushRejectedError && attempt < 2) continue;
          throw err;
        }
        const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;
        const result: WriteResult = { laneCommit, seq };
        const entries: Record<string, unknown> = {};
        for (const c of e.changes) entries[PENDING + c.path] = { blob: edits.get(c.path) ?? null, content: c.content, laneCommit } satisfies Pending;
        if (e.id) entries[WRITE + e.id] = result;
        try {
          await putAll(this.ctx.storage, entries, { seq, lastCommit: laneCommit });
        } catch (err) {
          // The commit landed but is not recorded: drop the cache so the next call replays it, and
          // still queue the merge (the merger reads the lane, not our bookkeeping).
          this.store = undefined;
          await this.notifyMerge(repo, e.agent);
          throw err;
        }
        this.tip = laneCommit;
        await this.clearIfMerged(laneCommit);
        await this.notifyMerge(repo, e.agent);
        return result;
      }
    });
  }

  /** Queue a merge of this lane. If the merger cannot be reached, keep it owed and retry from our alarm. */
  private async notifyMerge(repo: string, agent: string) {
    try {
      await this.env.MERGE_AGENT.get(this.env.MERGE_AGENT.idFromName(repo)).notify(repo, agent);
      await this.ctx.storage.delete("notifyOwed");
    } catch (err) {
      console.error(JSON.stringify({ event: "notify_failed", repo, agent, error: String(err) }));
      const tries = ((await this.ctx.storage.get<{ tries: number }>("notifyOwed"))?.tries ?? 0) + 1;
      await this.ctx.storage.put("notifyOwed", { repo, agent, tries });
      await this.ctx.storage.setAlarm(Date.now() + Math.min(5000 * 2 ** tries, 600_000));
    }
  }

  async alarm(): Promise<void> {
    const owed = await this.ctx.storage.get<{ repo: string; agent: string }>("notifyOwed");
    if (owed) await this.notifyMerge(owed.repo, owed.agent);
  }

  /** The agent's view: its own unmerged write of `path` if any, else main. */
  read(repo: string, agent: string, path: string): Promise<MainRead & { pending: boolean; approval?: { id: number; laneCommit: string } }> {
    // Behind the write queue, so a read always sees every write sent before it.
    return this.serial(async () => {
      await this.ready(repo, agent);
      const p = await this.ctx.storage.get<Pending>(PENDING + path);
      const main = await readMain(this.env.ARTIFACTS, repo, path);
      // Main already holds exactly what we wrote: the merge landed even if its ack never reached us.
      if (p && main.base === p.blob) await this.ctx.storage.delete(PENDING + path);
      else if (p) {
        // Waiting on a person? Say so: the agent should not build on text that may not land as written.
        const approval = await this.env.MERGE_AGENT.get(this.env.MERGE_AGENT.idFromName(repo)).approvalFor(agent, path);
        return { content: p.content, base: p.blob, pending: true, ...(approval ? { approval } : {}) };
      }
      return { ...main, pending: false };
    });
  }

  /** The merge agent folded these lane commits into main: their pending entries are no longer needed. */
  merged(laneCommits: string[]): Promise<void> {
    return this.serial(async () => {
      for (const c of laneCommits) await this.ctx.storage.put(MERGED + c, true);
      for (const c of laneCommits) await this.clearIfMerged(c);
    });
  }

  /** Drop pending entries written by `laneCommit` once a merge acknowledged it (whichever happened first). */
  private async clearIfMerged(laneCommit: string) {
    if (!(await this.ctx.storage.get<boolean>(MERGED + laneCommit))) return;
    const all = await this.ctx.storage.list<Pending>({ prefix: PENDING });
    const drop = [...all].filter(([, p]) => p.laneCommit === laneCommit).map(([k]) => k);
    // Keep the marker until it has cleared something: the write may not be recorded yet (a restart).
    if (drop.length) await this.ctx.storage.delete([...drop, MERGED + laneCommit]);
  }
}
