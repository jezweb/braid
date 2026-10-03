// The merge table: one record path, three inputs (the blob the writer edited
// from, main's blob now, the writer's new content). Pure; no git here.
//
// | Case                                      | Result                                  |
// | Different files                           | clean (never reaches this function)     |
// | Same file, different frontmatter keys     | clean, resolution "field"               |
// | Same key, different values                | last_edited_* follow the later edit as a group; else conflict |
// | Same file, different `##` sections        | clean                                   |
// | Same section, diff3 merges cleanly        | clean                                   |
// | Same section, overlapping lines           | conflict "overlap" (LLM proposes, person approves) |
// | Edit against delete                       | conflict "delete" (a person decides)    |
//
// Every part keeps its exact text, so an untouched part round-trips byte for byte.

import { diff3Merge } from "node-diff3";

export type MergeInput = {
  base: string | null; // null: the writer created the file
  ours: string | null; // main now; null: absent on main
  theirs: string | null; // the writer's content; null: the writer deleted it
};

export type Conflict =
  | { kind: "delete"; detail: string }
  | { kind: "field"; key: string; ours: string; theirs: string }
  | { kind: "overlap"; section: string; base: string; ours: string; theirs: string }
  | { kind: "order"; detail: string };

export type MergeResult =
  | { status: "clean"; content: string | null; resolution: "clean" | "field" }
  | { status: "conflict"; conflicts: Conflict[]; base: string | null; ours: string | null; theirs: string | null };

const LAST_EDITED = ["last_edited_at", "last_edited_by", "last_change_summary"];

export function mergeRecord({ base, ours, theirs }: MergeInput): MergeResult {
  if (ours === base) return { status: "clean", content: theirs, resolution: "clean" };
  if (theirs === base || theirs === ours) return { status: "clean", content: ours, resolution: "clean" };
  const conflict = (conflicts: Conflict[]): MergeResult => ({ status: "conflict", conflicts, base, ours, theirs });
  if (theirs === null) return conflict([{ kind: "delete", detail: "the writer deleted a record main has changed since" }]);
  if (ours === null) return conflict([{ kind: "delete", detail: "main deleted a record the writer has edited" }]);

  // Both sides hold text that differs from base (base may be null: both created it).
  const b = splitRecord(base ?? "");
  const o = splitRecord(ours);
  const t = splitRecord(theirs);
  const conflicts: Conflict[] = [];

  const fm = mergeFrontmatter(b, o, t);
  conflicts.push(...fm.conflicts);
  const body = threeWay(b.sections, o.sections, t.sections, mergeSection, (key) => ({
    kind: "delete",
    detail: `section ${partName(key)} was removed on one side and edited on the other`,
  }));
  conflicts.push(...body.conflicts);
  if (conflicts.length) return conflict(conflicts);

  const content = joinRecord({ frontmatter: fm.value, sections: body.value });
  const fmText = (x: Split) => JSON.stringify(x.frontmatter);
  const fieldMerge = fmText(o) !== fmText(b) && fmText(t) !== fmText(b) && fmText(o) !== fmText(t);
  return { status: "clean", content, resolution: fieldMerge ? "field" : "clean" };
}

// ---------- record shape: optional YAML frontmatter, then `##` sections ----------

/** A keyed slice of a record. key = name plus an occurrence index; text is exact. */
type Part = { key: string; text: string };
export type Split = { frontmatter: Part[] | null; sections: Part[] };

export function splitRecord(s: string): Split {
  const m = /^---\n([\s\S]*?\n)?---\n/.exec(s);
  if (!m) return { frontmatter: null, sections: parseParts(s, (l) => (/^## /.test(l) ? l.trim() : null)) };
  return {
    frontmatter: parseParts(m[1] ?? "", (l) => /^([A-Za-z0-9_-]+):/.exec(l)?.[1] ?? null),
    sections: parseParts(s.slice(m[0].length), (l) => (/^## /.test(l) ? l.trim() : null)),
  };
}

export function joinRecord(r: Split): string {
  const head = r.frontmatter ? `---\n${r.frontmatter.map((p) => p.text).join("")}---\n` : "";
  return head + r.sections.map((p) => p.text).join("");
}

/** Splits text into parts at lines `startsPart` names. Text before the first named line is the "" part. */
function parseParts(text: string, startsPart: (line: string) => string | null): Part[] {
  const out: Part[] = [];
  const seen = new Map<string, number>();
  let cur: Part = { key: "#0", text: "" };
  for (const line of text.split(/(?<=\n)/)) {
    if (!line) continue;
    const name = startsPart(line);
    if (name === null) { cur.text += line; continue; }
    if (cur.text || cur.key !== "#0") out.push(cur);
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    cur = { key: `${name}#${n}`, text: line };
  }
  if (cur.text || cur.key !== "#0") out.push(cur);
  return out;
}

function partName(key: string): string {
  return key.replace(/#\d+$/, "") || "(top)";
}

// ---------- three-way merge over keyed parts ----------

type Merged = { value: Part[]; conflicts: Conflict[] };

function threeWay(
  base: Part[],
  ours: Part[],
  theirs: Part[],
  onBoth: (key: string, b: string | undefined, o: string, t: string) => string | Conflict,
  onDeleteVsEdit: (key: string) => Conflict,
): Merged {
  const order = orderKeys(base, ours, theirs);
  if (!Array.isArray(order)) return { value: [], conflicts: [order] };
  const get = (xs: Part[], k: string) => xs.find((x) => x.key === k)?.text;
  const value: Part[] = [];
  const conflicts: Conflict[] = [];
  for (const key of order) {
    const b = get(base, key), o = get(ours, key), t = get(theirs, key);
    let text: string | undefined;
    if (o === b) text = t;
    else if (t === b || t === o) text = o;
    else if (o === undefined || t === undefined) { conflicts.push(onDeleteVsEdit(key)); continue; }
    else {
      const r = onBoth(key, b, o, t);
      if (typeof r !== "string") { conflicts.push(r); continue; }
      text = r;
    }
    if (text !== undefined) value.push({ key, text });
  }
  return { value, conflicts };
}

/**
 * Key order for the merged record. The side that reordered parts it shares with
 * base leads (both reordering differently is a conflict); the other side's new
 * parts go after their predecessor, after the leading side's own additions there.
 */
function orderKeys(base: Part[], ours: Part[], theirs: Part[]): string[] | Conflict {
  const shared = (side: Part[]) => {
    const inBase = new Set(base.map((p) => p.key));
    return side.map((p) => p.key).filter((k) => inBase.has(k));
  };
  const baseOrder = (side: Part[]) => {
    const inSide = new Set(side.map((p) => p.key));
    return base.map((p) => p.key).filter((k) => inSide.has(k));
  };
  const reordered = (side: Part[]) => shared(side).join("\n") !== baseOrder(side).join("\n");
  const oMoved = reordered(ours), tMoved = reordered(theirs);
  if (oMoved && tMoved) {
    const both = new Set(shared(theirs));
    const o = shared(ours).filter((k) => both.has(k)).join("\n");
    const t = shared(theirs).filter((k) => new Set(shared(ours)).has(k)).join("\n");
    if (o !== t) return { kind: "order", detail: "both sides moved parts into different orders" };
  }
  const [lead, other] = tMoved && !oMoved ? [theirs, ours] : [ours, theirs];
  const keys = lead.map((x) => x.key);
  const otherKeys = new Set(other.map((x) => x.key));
  let after = -1;
  for (const p of other) {
    const i = keys.indexOf(p.key);
    if (i >= 0) { after = i; continue; }
    while (after + 1 < keys.length && !otherKeys.has(keys[after + 1])) after++;
    keys.splice(++after, 0, p.key);
  }
  return keys;
}

function mergeSection(key: string, bv: string | undefined, ov: string, tv: string): string | Conflict {
  const lines = (s: string) => s.split(/(?<=\n)/);
  const regions = diff3Merge(lines(ov), lines(bv ?? ""), lines(tv));
  if (regions.some((r) => r.conflict)) return { kind: "overlap", section: partName(key), base: bv ?? "", ours: ov, theirs: tv };
  return regions.flatMap((r) => r.ok ?? []).join("");
}

// ---------- frontmatter ----------

function mergeFrontmatter(b: Split, o: Split, t: Split): { value: Part[] | null; conflicts: Conflict[] } {
  // Presence is three-way too: removing the block on one side removes it.
  const has = (x: Split) => x.frontmatter !== null;
  const present = has(o) === has(b) ? has(t) : has(o);
  const bf = b.frontmatter ?? [], of = o.frontmatter ?? [], tf = t.frontmatter ?? [];

  // last_edited_* move as one group, from whichever side edited later.
  const group = (xs: Part[]) => JSON.stringify(xs.filter((p) => LAST_EDITED.includes(partName(p.key))));
  let ours = of, theirs = tf;
  if (group(of) !== group(bf) && group(tf) !== group(bf)) {
    const winner = editedAt(of) > editedAt(tf) ? of : tf;
    ours = withGroupFrom(of, winner);
    theirs = withGroupFrom(tf, winner);
  }
  const res = threeWay(
    bf, ours, theirs,
    (key, _b, ov, tv) => ({ kind: "field", key: partName(key), ours: fieldValue(ov), theirs: fieldValue(tv) }),
    (key) => ({ kind: "field", key: partName(key), ours: fieldValue(of.find((p) => p.key === key)?.text), theirs: fieldValue(tf.find((p) => p.key === key)?.text) }),
  );
  if (!present) {
    if (res.value.length && JSON.stringify(res.value) !== JSON.stringify(has(o) ? of : tf)) {
      res.conflicts.push({ kind: "field", key: "(frontmatter)", ours: has(o) ? "kept" : "removed", theirs: has(t) ? "kept and edited" : "removed" });
    }
    return { value: null, conflicts: res.conflicts };
  }
  return { value: res.value, conflicts: res.conflicts };
}

function fieldValue(text: string | undefined): string {
  return (text ?? "").replace(/^[A-Za-z0-9_-]+:\s?/, "").trim();
}

/** Milliseconds of last_edited_at, or -Infinity when absent or unparseable (ties and unknowns go to the writer). */
function editedAt(xs: Part[]): number {
  const v = fieldValue(xs.find((p) => partName(p.key) === "last_edited_at")?.text).replace(/^["']|["']$/g, "");
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** `xs` with its last_edited_* parts replaced by `from`'s, in place; parts only `from` has are appended. */
function withGroupFrom(xs: Part[], from: Part[]): Part[] {
  const src = new Map(from.filter((p) => LAST_EDITED.includes(partName(p.key))).map((p) => [p.key, p.text]));
  const out: Part[] = [];
  for (const p of xs) {
    if (!LAST_EDITED.includes(partName(p.key))) out.push(p);
    else if (src.has(p.key)) { out.push({ key: p.key, text: src.get(p.key)! }); src.delete(p.key); }
  }
  for (const [key, text] of src) out.push({ key, text });
  return out;
}
