// The one contract. Every write is an envelope naming exactly what it changed and
// what it started from. Every envelope becomes one commit on the writer's lane;
// only the merge agent writes main, and main's commits carry every trailer.

export const NULL_OID = "0000000000000000000000000000000000000000";

export type Change = {
  path: string;
  /** Blob SHA the agent edited from; null = new file. */
  base: string | null;
  /** New content; null deletes. */
  content: string | null;
};

export type Envelope = {
  /** Agent slug, the commit author. */
  agent: string;
  changes: Change[];
  /** One line: the commit subject. */
  reason: string;
  /** Evidence. */
  source?: string;
};

export type Resolution = "clean" | "field" | "llm" | "human";

/** A path as a trailer names it: where it is and the blob it was edited from. */
export type RecordPath = { path: string; base: string | null };

export type Trailers = {
  agent?: string;
  source?: string;
  recordPaths: RecordPath[];
  laneCommit?: string;
  resolution?: Resolution;
  approvedBy?: string;
  reverts?: string;
};

/** `errors` names every trailer line that could not be read; a merge must refuse a lane commit with any. */
export type ParsedMessage = { subject: string; body: string; trailers: Trailers; errors: string[] };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OID = /^[0-9a-f]{40}$/;
const RESOLUTIONS: Resolution[] = ["clean", "field", "llm", "human"];

export class EnvelopeError extends Error {}

/** Throws EnvelopeError naming the first thing wrong; returns the envelope unchanged. */
export function validateEnvelope(e: Envelope): Envelope {
  const fail = (m: string): never => { throw new EnvelopeError(m); };
  if (!SLUG.test(e.agent ?? "")) fail(`agent must be a slug: ${JSON.stringify(e.agent)}`);
  if (!e.reason?.trim() || /[\r\n]/.test(e.reason)) fail("reason must be one non-empty line");
  if (e.source !== undefined && /[\r\n]/.test(e.source)) fail("source must be one line");
  if (!Array.isArray(e.changes) || e.changes.length === 0) fail("changes must be a non-empty list");
  const seen = new Set<string>();
  for (const c of e.changes) {
    if (!isRecordPath(c.path)) fail(`bad path: ${JSON.stringify(c.path)}`);
    if (seen.has(c.path)) fail(`path named twice: ${c.path}`);
    seen.add(c.path);
    for (const other of e.changes) if (other.path.startsWith(c.path + "/")) fail(`path is both a file and a folder: ${c.path}`);
    if (c.base !== null && !OID.test(c.base)) fail(`base must be a blob SHA or null: ${c.path}`);
    if (c.base === null && c.content === null) fail(`deleting a file needs its base: ${c.path}`);
    if (c.content !== null && typeof c.content !== "string") fail(`content must be text or null: ${c.path}`);
  }
  return e;
}

/** Relative, no dot segments, no empty segments, no whitespace at the ends, no newlines. */
export function isRecordPath(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > 512) return false;
  if (/[\r\n\0]/.test(p) || p !== p.trim()) return false;
  if (p.startsWith("/") || p.endsWith("/")) return false;
  return p.split("/").every((s) => s && s !== "." && s !== ".." && s !== ".git");
}

/** Lane commit message: reason, then trailers. */
export function laneMessage(e: Envelope): string {
  return formatMessage(e.reason, {
    agent: e.agent,
    source: e.source,
    recordPaths: e.changes.map((c) => ({ path: c.path, base: c.base })),
  });
}

export function formatMessage(subject: string, t: Trailers, body = ""): string {
  const lines: string[] = [];
  if (t.agent) lines.push(`Agent: ${t.agent}`);
  if (t.source) lines.push(`Source: ${t.source}`);
  for (const r of t.recordPaths) lines.push(`Record-Path: ${r.path} ${r.base ?? NULL_OID}`);
  if (t.laneCommit) lines.push(`Lane-Commit: ${t.laneCommit}`);
  if (t.resolution) lines.push(`Resolution: ${t.resolution}`);
  if (t.approvedBy) lines.push(`Approved-By: ${t.approvedBy}`);
  if (t.reverts) lines.push(`Reverts: ${t.reverts}`);
  return [subject.trim(), body.trim(), lines.join("\n")].filter(Boolean).join("\n\n") + "\n";
}

/** Reads our trailers from the last paragraph of a commit message. Unknown keys are ignored; malformed ones are errors. */
export function parseMessage(message: string): ParsedMessage {
  const paras = message.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const subject = paras[0] ?? "";
  const trailers: Trailers = { recordPaths: [] };
  const errors: string[] = [];
  const last = paras.length > 1 ? paras[paras.length - 1] : "";
  const lines = last.split("\n");
  const isTrailerPara = lines.some((l) => /^(Agent|Record-Path|Lane-Commit|Resolution|Reverts): /.test(l));
  if (isTrailerPara) {
    const once = (key: string, cur: unknown) => { if (cur !== undefined) errors.push(`${key} given twice`); };
    for (const line of lines) {
      const m = /^([A-Za-z-]+): (.*)$/.exec(line);
      if (!m) { errors.push(`not a trailer: ${JSON.stringify(line)}`); continue; }
      const [, key, raw] = m;
      const val = raw.trim();
      switch (key) {
        case "Agent": once(key, trailers.agent); trailers.agent = val; break;
        case "Source": once(key, trailers.source); trailers.source = val; break;
        case "Record-Path": {
          const sp = val.lastIndexOf(" ");
          const path = val.slice(0, sp);
          const base = val.slice(sp + 1);
          if (sp <= 0 || !OID.test(base) || !isRecordPath(path)) errors.push(`bad Record-Path: ${JSON.stringify(val)}`);
          else if (trailers.recordPaths.some((r) => r.path === path)) errors.push(`Record-Path names ${path} twice`);
          else trailers.recordPaths.push({ path, base: base === NULL_OID ? null : base });
          break;
        }
        case "Lane-Commit": once(key, trailers.laneCommit); if (OID.test(val)) trailers.laneCommit = val; else errors.push(`bad Lane-Commit: ${val}`); break;
        case "Resolution": once(key, trailers.resolution); if ((RESOLUTIONS as string[]).includes(val)) trailers.resolution = val as Resolution; else errors.push(`bad Resolution: ${val}`); break;
        case "Approved-By": once(key, trailers.approvedBy); trailers.approvedBy = val; break;
        case "Reverts": once(key, trailers.reverts); if (OID.test(val)) trailers.reverts = val; else errors.push(`bad Reverts: ${val}`); break;
      }
    }
  }
  const body = paras.slice(1, isTrailerPara ? -1 : undefined).join("\n\n");
  return { subject, body, trailers, errors };
}

/** A lane commit's trailers, or the reasons it cannot be merged as an envelope. */
export function laneTrailers(message: string): { ok: true; parsed: ParsedMessage } | { ok: false; errors: string[] } {
  const parsed = parseMessage(message);
  const errors = [...parsed.errors];
  if (!parsed.trailers.agent || !SLUG.test(parsed.trailers.agent)) errors.push("missing or bad Agent");
  if (parsed.trailers.recordPaths.length === 0) errors.push("no Record-Path");
  const paths = parsed.trailers.recordPaths.map((r) => r.path);
  for (const p of paths) if (paths.some((q) => q.startsWith(p + "/"))) errors.push(`path is both a file and a folder: ${p}`);
  return errors.length ? { ok: false, errors } : { ok: true, parsed };
}
