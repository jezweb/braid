// The viewer's API. Reads are open (the demo data is made up); acting routes
// (/api/act/*) need an identity: Cloudflare Access's verified email header in
// production, or DEMO_ACTOR when Access is not yet in front.

import { Hono } from "hono";
import { parseMessage } from "./contract";
import { blobAtRef } from "./artifacts";
import { history, revertEnvelope } from "./primitives";
import type { Lane } from "./do/lane";
import type { MergeAgent, ResolveAction } from "./do/merge-agent";

export type ApiEnv = {
  ARTIFACTS: Artifacts;
  LANE: DurableObjectNamespace<Lane>;
  MERGE_AGENT: DurableObjectNamespace<MergeAgent>;
  /** Canonical repo the viewer shows. */
  REPO?: string;
  /** The lane a person's undo and edits are written through. */
  PERSON_AGENT?: string;
  /** Identity used for acting when Cloudflare Access is not in front (local dev, early demo). */
  DEMO_ACTOR?: string;
  /** Without Access, acting as DEMO_ACTOR needs this key in `x-demo-key`. It grants approve and undo only. */
  ACT_KEY?: string;
  /** Cloudflare Access: the team domain (https://<team>.cloudflareaccess.com) and the application's AUD tag. */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
};

/** The verified email from a Cloudflare Access JWT, or undefined. Only trusted when ACCESS_TEAM and ACCESS_AUD are set. */
async function accessEmail(env: ApiEnv, jwt: string | undefined): Promise<string | undefined> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD || !jwt) return undefined;
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return undefined;
  // JWT segments are base64url without padding; atob wants standard base64 padded to a multiple of 4.
  const dec = (x: string) => {
    const b = x.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b + "=".repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };
  let header: { kid?: string; alg?: string }, payload: { aud?: string | string[]; email?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(dec(h)));
    payload = JSON.parse(new TextDecoder().decode(dec(p)));
  } catch {
    return undefined;
  }
  if (header.alg !== "RS256") return undefined;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD) || (payload.exp ?? 0) * 1000 < Date.now() || payload.iss !== env.ACCESS_TEAM) return undefined;
  const certs = (await (await fetch(`${env.ACCESS_TEAM}/cdn-cgi/access/certs`)).json()) as { keys: (JsonWebKey & { kid: string })[] };
  const jwk = certs.keys.find((k) => k.kid === header.kid);
  if (!jwk) return undefined;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, dec(sig), new TextEncoder().encode(`${h}.${p}`));
  return ok ? payload.email : undefined;
}

export type MainCommit = {
  hash: string;
  parents: string[];
  subject: string;
  agent?: string;
  source?: string;
  resolution?: string;
  approvedBy?: string;
  reverts?: string;
  laneCommit?: string;
  paths: string[];
  at: number;
};

const repoOf = (env: ApiEnv) => env.REPO ?? "memory";
/** Reads may look at any repo in the namespace (?repo=); acting is only ever on REPO. */
const readRepo = (env: ApiEnv, q: string | undefined) => (q && /^[a-z0-9][a-z0-9-]{0,40}$/.test(q) ? q : repoOf(env));

/** The repo handle, or null when it does not exist (yet). */
async function open(env: ApiEnv, repo: string): Promise<ArtifactsRepo | null> {
  try {
    const r = await env.ARTIFACTS.get(repo);
    await r.info();
    return r;
  } catch {
    return null;
  }
}
const personOf = (env: ApiEnv) => env.PERSON_AGENT ?? "person";
const mergeAgent = (env: ApiEnv) => env.MERGE_AGENT.get(env.MERGE_AGENT.idFromName(repoOf(env)));

async function textOf(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
  const oid = await blobAtRef(repo, ref, path);
  if (!oid) return null;
  return (await repo.readBlob(oid))?.text() ?? null;
}

export const api = new Hono<{ Bindings: ApiEnv; Variables: { actor: string } }>();

api.get("/state", async (c) => {
  const env = c.env;
  const repo = readRepo(env, c.req.query("repo"));
  const handle = await open(env, repo);
  if (!handle) return c.json({ repo, missing: true, main: [], lanes: [], approvals: [] });
  using r = handle;
  const log = await r.log({ ref: "main", limit: Number(c.req.query("limit") ?? 60) });
  const main: MainCommit[] = log.map((x) => {
    const { subject, trailers: t } = parseMessage(x.message);
    return { hash: x.hash, parents: x.parents, subject, agent: t.agent, source: t.source, resolution: t.resolution, approvedBy: t.approvedBy, reverts: t.reverts, laneCommit: t.laneCommit, paths: t.recordPaths.map((p) => p.path), at: x.committedAt };
  });
  const ma = env.MERGE_AGENT.get(env.MERGE_AGENT.idFromName(repo));
  const [status, waiting] = await Promise.all([ma.status(), ma.approvals("open")]);
  return c.json({ repo, actOn: repoOf(env), main, lanes: status.lanes, approvals: waiting.map((a) => ({ id: a.id, agent: a.agent, path: a.path, createdAt: a.createdAt, hasProposal: !!a.proposal })) });
});

api.get("/approvals/:id", async (c) => {
  const repo = readRepo(c.env, c.req.query("repo"));
  const a = await c.env.MERGE_AGENT.get(c.env.MERGE_AGENT.idFromName(repo)).approval(Number(c.req.param("id")));
  return a ? c.json(a) : c.notFound();
});

api.get("/history", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  return c.json(await history(c.env.ARTIFACTS, readRepo(c.env, c.req.query("repo")), path, 1000));
});

/** A record as it stood after `ref` (default main), and before it when `ref` is a commit. */
api.get("/record", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  const ref = c.req.query("ref") ?? "main";
  using r = await c.env.ARTIFACTS.get(readRepo(c.env, c.req.query("repo")));
  const after = await textOf(r, ref, path);
  let before: string | null | undefined;
  if (ref !== "main") {
    const commit = await r.readCommit(ref);
    before = commit?.parents[0] ? await textOf(r, commit.parents[0], path) : null;
  }
  return c.json({ path, ref, after, before });
});

/** Every record path on main. */
api.get("/records", async (c) => {
  const handle = await open(c.env, readRepo(c.env, c.req.query("repo")));
  if (!handle) return c.json([]);
  using r = handle;
  const head = (await r.log({ ref: "main", limit: 1 }))[0];
  if (!head) return c.json([]);
  const out: string[] = [];
  const walk = async (tree: string, prefix: string) => {
    for (const e of (await r.readTree(tree)) ?? []) {
      if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
      else if (e.type === "blob") out.push(prefix + e.name);
    }
  };
  await walk(head.treeHash, "");
  return c.json(out.sort());
});

// ------------------------------------------------------------------ acting

api.use("/act/*", async (c, next) => {
  // Identity comes from a verified Cloudflare Access JWT, never from a header a caller could set.
  // Until Access is configured, DEMO_ACTOR stands in for holders of ACT_KEY (and says so in every trailer).
  const verified = await accessEmail(c.env, c.req.header("cf-access-jwt-assertion"));
  const demo = !!c.env.DEMO_ACTOR && !!c.env.ACT_KEY && c.req.header("x-demo-key") === c.env.ACT_KEY;
  const actor = verified ?? (demo ? `${c.env.DEMO_ACTOR} (demo)` : undefined);
  if (!actor) return c.json({ error: "sign in to act" }, 401);
  // Acting is only ever on REPO. A viewer watching another repo must not resolve REPO's approval with the same id.
  const named = c.req.query("repo");
  if (named !== repoOf(c.env)) return c.json({ error: `actions apply to ${repoOf(c.env)} only` }, 409);
  c.set("actor", actor);
  await next();
});

api.post("/act/approvals/:id", async (c) => {
  const body = await c.req.json<{ action: ResolveAction; text?: string }>();
  if (!["approve", "ours", "theirs", "edit"].includes(body.action)) return c.json({ error: "action must be approve, ours, theirs or edit" }, 400);
  try {
    return c.json(await mergeAgent(c.env).resolve(repoOf(c.env), Number(c.req.param("id")), body.action, c.get("actor"), body.text));
  } catch (e) {
    return c.json({ error: String(e) }, 409);
  }
});

/** Undo a main commit (one path, or all it changed): a write through the person's lane. */
api.post("/act/undo", async (c) => {
  const body = await c.req.json<{ commit: string; path?: string }>();
  if (!/^[0-9a-f]{40}$/.test(body.commit ?? "")) return c.json({ error: "commit must be a SHA" }, 400);
  const repo = repoOf(c.env);
  const agent = personOf(c.env);
  try {
    const e = await revertEnvelope(c.env.ARTIFACTS, repo, agent, body.commit, body.path);
    e.source = `undo by ${c.get("actor")}`;
    e.id = `undo-${body.commit.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
    const lane = c.env.LANE.get(c.env.LANE.idFromName(`${repo}:${agent}`));
    return c.json(await lane.write(repo, e));
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});
