import { Hono } from "hono";
import { mergeLane, type MergeLaneOptions } from "./merge-lane";
import type { Remote } from "./git/store";
import { runG0 } from "./g0";
import { runMergeRace, runRace } from "./spike-race";

type Env = { SPIKE?: string; SPIKE_KEY?: string; ARTIFACTS: Artifacts };

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("braid"));

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

export default app;
