// G1 on real Artifacts: 20 concurrent writes from 5 lanes land on their forks in
// order, none lost; a second write before the first merges carries the right base.

import { parseMessage, type Envelope } from "./contract";
import { blobAtRef } from "./artifacts";
import { Store } from "./git/store";
import type { Lane } from "./do/lane";

type Env = { ARTIFACTS: Artifacts; LANE: DurableObjectNamespace<Lane> };

const AGENTS = ["scout", "fact-checker", "editor", "translator", "archivist"];
const STACKED = "towns/harbourne.md";

export async function runG1(env: Env) {
  const repo = `g1-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  const created = await env.ARTIFACTS.create(repo, { setDefaultBranch: "main" });
  const lanes = (agent: string) => env.LANE.get(env.LANE.idFromName(`${repo}:${agent}`));
  try {
    const seed = await Store.open();
    const tree = await seed.editTree(null, new Map([[STACKED, await seed.writeText("# Harbourne\n\nA made-up river town.\n")]]));
    await seed.push({ url: created.remote, token: created.token }, await seed.commit({ tree, parents: [], message: "seed", author: { name: "seed", email: "seed@braid.invalid" } }));

    // 4 writes per agent, issued at once per agent and across agents (20 in flight).
    // The editor's writes 3 and 4 edit one record; write 4 is sent after reading back write 3.
    const sent: Record<string, string[]> = {};
    let stackedBase: string | null = null;
    let stackedSecondBase: string | null = null;
    let retried: { laneCommit: string; repeated?: boolean } | undefined;
    const jobs = AGENTS.map(async (agent) => {
      const lane = lanes(agent);
      sent[agent] = [];
      const calls: Promise<unknown>[] = [];
      for (let n = 1; n <= 4; n++) {
        if (agent === "editor" && n >= 3) continue;
        const reason = `${agent} write ${n}`;
        sent[agent].push(reason);
        const e: Envelope = { agent, reason, id: `${agent}-${n}`, changes: [{ path: `notes/${agent}/${n}.md`, base: null, content: `${agent} ${n}\n` }] };
        calls.push(lane.write(repo, e));
        // The archivist's last write is sent twice with one id, as a client retry would: it must land once.
        if (agent === "archivist" && n === 4) calls.push(lane.write(repo, e).then((r) => { retried = r; return r; }));
      }
      if (agent === "editor") {
        const r1 = await lane.read(repo, agent, STACKED);
        stackedBase = r1.base;
        sent[agent].push("editor write 3");
        await lane.write(repo, { agent, reason: "editor write 3", changes: [{ path: STACKED, base: r1.base, content: "# Harbourne\n\nA made-up town by a river.\n" }] });
        const r2 = await lane.read(repo, agent, STACKED); // before anything merges: must be the editor's own pending blob
        stackedSecondBase = r2.base;
        sent[agent].push("editor write 4");
        calls.push(lane.write(repo, { agent, reason: "editor write 4", changes: [{ path: STACKED, base: r2.base, content: "# Harbourne\n\nA made-up town by a slow river.\n" }] }));
      }
      return Promise.all(calls);
    });
    const settled = await Promise.allSettled(jobs);
    const errors = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));

    // What landed, per lane, oldest first.
    const landed: Record<string, string[]> = {};
    let editor3: string | undefined, editor4Base: string | null | undefined;
    for (const agent of AGENTS) {
      using r = await env.ARTIFACTS.get(`${repo}--${agent}`);
      const log = (await r.log({ ref: "main", limit: 50 })).reverse().filter((c) => c.message.startsWith(`${agent} write`));
      landed[agent] = log.map((c) => c.message.split("\n")[0]);
      if (agent === "editor") {
        const c3 = log.find((c) => c.message.startsWith("editor write 3"));
        const c4 = log.find((c) => c.message.startsWith("editor write 4"));
        editor3 = c3 ? (await blobAtRef(r, c3.hash, STACKED)) ?? undefined : undefined;
        editor4Base = c4 ? parseMessage(c4.message).trailers.recordPaths[0]?.base : undefined;
      }
    }
    const total = Object.values(landed).reduce((n, xs) => n + xs.length, 0);
    const inOrder = AGENTS.every((a) => JSON.stringify(landed[a]) === JSON.stringify(sent[a]));
    const retryOnce = retried?.repeated === true && landed.archivist.filter((x) => x === "archivist write 4").length === 1;
    const rightBase = !!editor3 && editor4Base === editor3 && stackedSecondBase === editor3 && stackedBase !== editor3;
    return {
      pass: errors.length === 0 && total === 20 && inOrder && rightBase && retryOnce,
      repo, ms: Date.now() - t0, sent: 20, landed: total, inOrder, rightBase, retryOnce,
      stacked: { firstBase: stackedBase, editor3Blob: editor3, secondBaseRead: stackedSecondBase, editor4Trailer: editor4Base },
      lanes: landed, errors,
    };
  } finally {
    for (const a of AGENTS) await env.ARTIFACTS.delete(`${repo}--${a}`).catch(() => false);
    await env.ARTIFACTS.delete(repo).catch(() => false);
  }
}
