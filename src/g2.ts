// G2 on real Artifacts: all 20 writes merge (merged = sent); the scripted overlap
// gives exactly one approval; the editor's stacked writes give none.

import { parseMessage, type Envelope } from "./contract";
import { Store } from "./git/store";
import type { Lane } from "./do/lane";
import type { MergeAgent } from "./do/merge-agent";

type Env = { ARTIFACTS: Artifacts; LANE: DurableObjectNamespace<Lane>; MERGE_AGENT: DurableObjectNamespace<MergeAgent> };

const AGENTS = ["scout", "fact-checker", "editor", "translator", "archivist"];
const TOWN = "towns/harbourne.md";
const SEED_TOWN = `---
title: Harbourne
status: draft
---
# Harbourne

## Summary

Harbourne is a made-up river town with one bridge and a flour mill.

## Contacts

Town hall: 555 0100
`;

export async function runG2(env: Env, keep = false, c: { proposal?: boolean; repo?: string; resolve?: boolean; person?: string } = {}) {
  const repo = c.repo ?? `g2-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  const steps: { step: string; ms: number }[] = [];
  const mark = (step: string) => steps.push({ step, ms: Date.now() - t0 });
  // A repo deleted a moment ago (the demo rebuild) may not free its name at once: retry briefly.
  let created: ArtifactsCreateRepoResult | undefined;
  for (let i = 0; !created; i++) {
    try { created = await env.ARTIFACTS.create(repo, { setDefaultBranch: "main" }); }
    catch (e) { if (i >= 5 || !c.repo) throw e; await new Promise((ok) => setTimeout(ok, 1000 * (i + 1))); }
  }
  const lane = (agent: string) => env.LANE.get(env.LANE.idFromName(`${repo}:${agent}`));
  const ma = env.MERGE_AGENT.get(env.MERGE_AGENT.idFromName(repo));
  const drained = async (limitMs = 180_000) => {
    const start = Date.now();
    for (;;) {
      const s = await ma.status();
      if (s.alarm === null && s.lanes.every((l) => l.dirty === 0)) return s;
      if (Date.now() - start > limitMs) throw new Error(`queue not drained: ${JSON.stringify(s)}`);
      await new Promise((ok) => setTimeout(ok, 500));
    }
  };
  try {
    const seed = await Store.open();
    const tree = await seed.editTree(null, new Map([[TOWN, await seed.writeText(SEED_TOWN)]]));
    await seed.push({ url: created.remote, token: created.token }, await seed.commit({ tree, parents: [], message: "seed", author: { name: "seed", email: "seed@braid.invalid" } }));
    mark("seeded");

    // The translator reads the town now and will write from this stale read later.
    const stale = await lane("translator").read(repo, "translator", TOWN);
    mark("lanes provisioned (translator)");

    const writes = AGENTS.map(async (agent) => {
      const l = lane(agent);
      const calls: Promise<unknown>[] = [];
      const note = (n: number) => l.write(repo, { agent, reason: `${agent} write ${n}`, id: `${agent}-${n}`, changes: [{ path: `notes/${agent}/${n}.md`, base: null, content: `${agent} ${n}\n` }] });
      if (agent === "editor") {
        calls.push(note(1), note(2));
        const r = await l.read(repo, agent, TOWN);
        await l.write(repo, { agent, reason: "editor write 3", id: "editor-3", changes: [{ path: TOWN, base: r.base, content: r.content!.replace("one bridge and a flour mill", "one stone bridge and a flour mill") }] });
        const r2 = await l.read(repo, agent, TOWN); // its own pending write
        calls.push(l.write(repo, { agent, reason: "editor write 4", id: "editor-4", changes: [{ path: TOWN, base: r2.base, content: r2.content!.replace("flour mill", "working flour mill") }] }));
      } else if (agent === "fact-checker") {
        calls.push(note(1), note(2), note(3));
        const r = await l.read(repo, agent, TOWN);
        calls.push(l.write(repo, { agent, reason: "fact-checker write 4", id: "fact-checker-4", changes: [{ path: TOWN, base: r.base, content: r.content!.replace("555 0100", "555 0142") }] }));
      } else if (agent === "translator") {
        calls.push(note(1), note(2), note(3));
      } else {
        for (let n = 1; n <= 4; n++) calls.push(note(n));
      }
      return Promise.all(calls);
    });
    const settled = await Promise.allSettled(writes);
    const errors = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));
    mark("19 writes landed on lanes");
    const afterFirst = await drained();
    mark("queue drained");
    const approvalsBeforeOverlap = (await ma.approvals("open")).length;

    // The scripted overlap: the same sentence, from the stale read.
    const overlap: Envelope = {
      agent: "translator", reason: "translator write 4", id: "translator-4",
      changes: [{ path: TOWN, base: stale.base, content: stale.content!.replace("is a made-up river town with one bridge and a flour mill", "is a made-up river town with two bridges and an old flour mill") }],
    };
    await lane("translator").write(repo, overlap);
    await drained();
    mark("overlap drained");
    const open = await ma.approvals("open");
    const readWhileHeld = await lane("translator").read(repo, "translator", TOWN);
    const a = open[0];
    if (c.resolve === false) {
      // Demo seed: leave the approval open for a person, and give the person a lane now (a fork takes seconds).
      if (c.person) await ma.provisionLane(repo, c.person);
      return { repo, ms: Date.now() - t0, openApprovals: open.length, steps, errors };
    }
    const action = c.proposal === false || !a?.proposal ? "theirs" : "approve";
    if (a) await ma.resolve(repo, a.id, action, "g2-runner@braid.invalid");
    const final = await drained();
    mark("approval merged");

    using r = await env.ARTIFACTS.get(repo);
    const log = await r.log({ ref: "main", limit: 100 });
    const merges = log.map((c) => parseMessage(c.message).trailers).filter((t) => t.laneCommit);
    const laneCommits = new Set(merges.map((t) => t.laneCommit));
    const approved = merges.filter((t) => t.approvedBy);
    const editorMerges = merges.filter((t) => t.agent === "editor");
    const town = await (await r.readFile({ ref: "main", path: TOWN }))!.text();
    const pass =
      errors.length === 0 && laneCommits.size === 20 && merges.length === 20 &&
      approvalsBeforeOverlap === 0 && open.length === 1 && approved.length === 1 &&
      editorMerges.every((t) => !t.approvedBy) && !!readWhileHeld.approval &&
      // Every writer's change survives: the fact-checker's number, and the overlap resolved one way or the other.
      town.includes("555 0142") && (town.includes("two bridges") || town.includes("stone bridge"));
    return {
      pass, repo, ms: Date.now() - t0, sent: 20, mergedOnMain: laneCommits.size, mergeCommits: merges.length,
      approvalsBeforeOverlap, approvals: open.map((x) => ({ id: x.id, agent: x.agent, path: x.path, conflicts: x.conflicts, proposalModel: x.proposalModel, proposal: x.proposal })),
      approvedTrailers: approved, readWhileHeld: { pending: readWhileHeld.pending, approval: readWhileHeld.approval },
      resolutions: merges.map((t) => `${t.agent}:${t.resolution}`), town, lanes: final.lanes, firstDrain: afterFirst.lanes, steps, errors,
    };
  } finally {
    if (!keep) {
      for (const a of AGENTS) await env.ARTIFACTS.delete(`${repo}--${a}`).catch(() => false);
      await env.ARTIFACTS.delete(repo).catch(() => false);
    }
  }
}
