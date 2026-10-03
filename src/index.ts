import { Hono } from "hono";
import { mergeLane, type MergeLaneOptions } from "./merge-lane";
import type { Remote } from "./git/store";
import { runG0 } from "./g0";
import { runMergeRace, runRace } from "./spike-race";

import type { Lane } from "./do/lane";
import type { MergeAgent } from "./do/merge-agent";
import { runG1 } from "./g1";
import { runG2 } from "./g2";
import { api } from "./api";
import { DEFAULT_PROPOSAL_MODEL, proposeSection } from "./propose";

export { Lane } from "./do/lane";
export { MergeAgent } from "./do/merge-agent";

type Env = {
  SPIKE?: string;
  SPIKE_KEY?: string;
  ARTIFACTS: Artifacts;
  LANE: DurableObjectNamespace<Lane>;
  MERGE_AGENT: DurableObjectNamespace<MergeAgent>;
  AI: Ai;
  PROPOSAL_MODEL?: string;
  REPO?: string;
  PERSON_AGENT?: string;
  DEMO_ACTOR?: string;
  ACT_KEY?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

// G0 spike: local dev only (SPIKE=1 in .dev.vars). Removed once G0 passes on Artifacts.
app.post("/spike/merge", async (c) => {
  if (c.env.SPIKE !== "1") return c.notFound();
  const body = await c.req.json<{ canonical: Remote; lane: Remote; opts: MergeLaneOptions }>();
  try {
    return c.json(await mergeLane(body.canonical, body.lane, body.opts));
  } catch (e) {
    console.error(JSON.stringify({ event: "spike_merge_error", error: String(e), stack: (e as Error).stack }));
    return c.json({ error: String(e) }, 500);
  }
});

// G0 on real Artifacts. Needs the SPIKE_KEY secret as a bearer; absent secret = route off.
app.post("/spike/g0", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  return c.json(await runG0(c.env.ARTIFACTS, c.req.query("keep") === "1"));
});

app.post("/spike/race", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  return c.json(await runRace(c.env.ARTIFACTS, Number(c.req.query("rounds") ?? 10)));
});

app.post("/spike/merge-race", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  return c.json(await runMergeRace(c.env.ARTIFACTS, Number(c.req.query("lanes") ?? 4)));
});

app.post("/spike/g1", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  return c.json(await runG1(c.env));
});

app.post("/spike/g2", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  return c.json(await runG2(c.env, c.req.query("keep") === "1", { proposal: c.req.query("proposal") !== "0" }));
});

// An agent edits one record of the demo repo: read through its lane, replace text, write.
app.post("/spike/agent-edit", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  const { agent, path, find, replace, reason } = await c.req.json<{ agent: string; path: string; find: string; replace: string; reason?: string }>();
  const repo = c.env.REPO ?? "memory";
  const lane = c.env.LANE.get(c.env.LANE.idFromName(`${repo}:${agent}`));
  const r = await lane.read(repo, agent, path);
  if (r.content === null || !r.content.includes(find)) return c.json({ error: "text not found", content: r.content }, 409);
  return c.json(await lane.write(repo, { agent, reason: reason ?? `${agent} edits ${path}`, changes: [{ path, base: r.base, content: r.content.replace(find, replace) }] }));
});

// Rebuild the demo repo (REPO) from scratch and leave it mid-story: lanes merged, one approval open.
app.post("/spike/demo-seed", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  const repo = c.env.REPO ?? "memory";
  const ma = c.env.MERGE_AGENT.get(c.env.MERGE_AGENT.idFromName(repo));
  // A rebuild is only safe while nothing is in flight: no dirty lane, no pending merge.
  const busy = await ma.status();
  if (busy.alarm !== null || busy.lanes.some((l) => l.dirty > 0)) return c.json({ error: "merges in flight; try again when the queue is idle", busy }, 409);
  const known = await ma.reset(repo);
  const agents = new Set([...known, "scout", "fact-checker", "editor", "translator", "archivist", c.env.PERSON_AGENT ?? "person"]);
  for (const a of agents) {
    await c.env.LANE.get(c.env.LANE.idFromName(`${repo}:${a}`)).reset();
    await c.env.ARTIFACTS.delete(`${repo}--${a}`).catch(() => false);
  }
  await c.env.ARTIFACTS.delete(repo).catch(() => false);
  try {
    return c.json(await runG2(c.env, true, { repo, resolve: false, person: c.env.PERSON_AGENT ?? "person" }));
  } catch (e) {
    console.error(JSON.stringify({ event: "demo_seed_failed", error: String(e), stack: (e as Error).stack }));
    return c.json({ error: String(e) }, 500);
  }
});

app.post("/spike/propose", async (c) => {
  const key = c.env.SPIKE_KEY;
  if (!key || c.req.header("authorization") !== `Bearer ${key}`) return c.notFound();
  const model = c.req.query("model") || c.env.PROPOSAL_MODEL || DEFAULT_PROPOSAL_MODEL;
  const t0 = Date.now();
  const sec = { kind: "overlap" as const, section: "## Summary",
    base: "## Summary\n\nHarbourne is a made-up river town with one bridge and a flour mill.\n\n",
    ours: "## Summary\n\nHarbourne is a made-up river town with one stone bridge and a working flour mill.\n\n",
    theirs: "## Summary\n\nHarbourne is a made-up river town with two bridges and an old flour mill.\n\n" };
  let raw: unknown, error: string | undefined, text: string | undefined;
  try {
    text = await proposeSection(c.env.AI, model, sec);
  } catch (e) { error = String(e); }
  return c.json({ model, ms: Date.now() - t0, raw, text, error });
});

export default app;
