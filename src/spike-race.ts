// Does Artifacts refuse a stale ref update (compare-and-swap on the old tip)?
// Two stores fetch main, each commits a different child, and both push at once
// with `force` so isomorphic-git skips its own fast-forward check: only the
// server can refuse. Repeated `rounds` times on one fresh repo.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Store, type Remote } from "./git/store";

async function child(remote: Remote, label: string) {
  const s = await Store.open();
  const tip = (await s.fetch(remote, "main", 1))!;
  const tree = await s.editTree((await s.readCommit(tip)).tree, new Map([[`race/${label}.md`, await s.writeText(label + "\n")]]));
  const oid = await s.commit({ tree, parents: [tip], message: `race ${label}`, author: { name: "race", email: "race@braid.invalid" } });
  await git.writeRef({ fs: s.fs, gitdir: s.gitdir, ref: "refs/heads/out", value: oid, force: true });
  return { s, tip, oid };
}

async function pushForced(remote: Remote, c: Awaited<ReturnType<typeof child>>) {
  try {
    const res = await git.push({
      fs: c.s.fs, gitdir: c.s.gitdir, http, url: remote.url, ref: "refs/heads/out", remoteRef: "refs/heads/main", force: true,
      onAuth: () => ({ username: "x", password: remote.token!.split("?expires=")[0] }),
    });
    return { ok: !!res.ok && !!res.refs?.["refs/heads/main"]?.ok, detail: JSON.stringify(res.refs) };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export async function runRace(artifacts: Artifacts, rounds = 10) {
  const name = `race-${crypto.randomUUID().slice(0, 8)}`;
  const created = await artifacts.create(name, { setDefaultBranch: "main" });
  const remote = { url: created.remote, token: created.token };
  const results: { round: number; sameBase: boolean; a: unknown; b: unknown; mainIs: string; lost: boolean }[] = [];
  try {
    const seed = await Store.open();
    const tree = await seed.editTree(null, new Map([["README.md", await seed.writeText("race\n")]]));
    await seed.push(remote, await seed.commit({ tree, parents: [], message: "seed", author: { name: "race", email: "race@braid.invalid" } }));
    for (let i = 0; i < rounds; i++) {
      const [a, b] = await Promise.all([child(remote, `a${i}`), child(remote, `b${i}`)]);
      const [pa, pb] = await Promise.all([pushForced(remote, a), pushForced(remote, b)]);
      const check = await Store.open();
      const mainIs = (await check.fetch(remote, "main", 1))!;
      const winner = mainIs === a.oid ? "a" : mainIs === b.oid ? "b" : "neither";
      // A lost write: a push that reported success whose commit is not main (and main is not built on it).
      const lost = (pa.ok && winner !== "a") || (pb.ok && winner !== "b");
      results.push({ round: i, sameBase: a.tip === b.tip, a: pa, b: pb, mainIs: winner, lost });
    }
  } finally {
    await artifacts.delete(name).catch(() => false);
  }
  const overlapping = results.filter((r) => r.sameBase);
  return {
    rounds,
    sameBaseRounds: overlapping.length,
    bothReportedOk: overlapping.filter((r) => (r.a as { ok: boolean }).ok && (r.b as { ok: boolean }).ok).length,
    lostWrites: results.filter((r) => r.lost).length,
    results,
  };
}

/** Two lanes merged into one main at the same moment: both must land, one through a retry. */
export async function runMergeRace(artifacts: Artifacts, lanes = 4) {
  const { laneMessage } = await import("./contract");
  const { mergeLane } = await import("./merge-lane");
  const name = `mrace-${crypto.randomUUID().slice(0, 8)}`;
  const created = await artifacts.create(name, { setDefaultBranch: "main" });
  const canonical = { url: created.remote, token: created.token };
  const forks: string[] = [];
  try {
    const seed = await Store.open();
    const tree = await seed.editTree(null, new Map([["README.md", await seed.writeText("race\n")]]));
    const forkPoint = await seed.commit({ tree, parents: [], message: "seed", author: { name: "race", email: "race@braid.invalid" } });
    await seed.push(canonical, forkPoint);
    const agents = Array.from({ length: lanes }, (_, i) => `agent-${i}`);
    // Forks one at a time: 8 concurrent fork() calls on one repo failed with INTERNAL_ERROR (3 Oct 2026).
    const forked: { agent: string; remote: Remote }[] = [];
    for (const agent of agents) {
      using repo = await artifacts.get(name);
      const f = await repo.fork(`${name}--${agent}`, { defaultBranchOnly: true });
      forks.push(f.name);
      forked.push({ agent, remote: { url: f.remote, token: f.token } });
    }
    const laneRemotes = await Promise.all(forked.map(async ({ agent, remote }) => {
      const s = await Store.open();
      const tip = (await s.fetch(remote, "main", 1))!;
      const path = `notes/${agent}.md`;
      const t = await s.editTree((await s.readCommit(tip)).tree, new Map([[path, await s.writeText(`${agent}\n`)]]));
      const msg = laneMessage({ agent, reason: `${agent} note`, changes: [{ path, base: null, content: `${agent}\n` }] });
      await s.push(remote, await s.commit({ tree: t, parents: [tip], message: msg, author: { name: agent, email: `${agent}@braid.invalid` } }));
      return remote;
    }));
    const t0 = Date.now();
    const results = await Promise.all(laneRemotes.map((lane) => mergeLane(canonical, lane, { since: forkPoint, attempts: lanes + 2 }).then(
      (r) => ({ ok: true, outcomes: r.outcomes.map((o) => o.status), ms: r.ms }),
      (e) => ({ ok: false, error: String(e) }),
    )));
    using repo = await artifacts.get(name);
    const log = await repo.log({ ref: "main", limit: 20 });
    const landed = agents.filter((a) => log.some((c) => c.message.includes(`Agent: ${a}`)));
    return { lanes, ms: Date.now() - t0, results, landed: landed.length, mainCommits: log.length, pass: landed.length === lanes && results.every((r) => r.ok) };
  } finally {
    for (const f of forks) await artifacts.delete(f).catch(() => false);
    await artifacts.delete(name).catch(() => false);
  }
}
