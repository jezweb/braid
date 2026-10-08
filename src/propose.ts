// LLM merge proposals: for each overlapping section, ask a model for one text
// that keeps both edits' intent. A person approves, edits or picks a side; a
// proposal never lands on its own.

import { mergeRecord, pickSide, type Conflict } from "./merge";

// Chosen 3 Oct 2026 on the merge prompt: kimi-k2.6 (thinking off) merged both edits faithfully in 1.3 s.
// glm-5.3-flash ignored the thinking switches (33 to 46 s); gpt-oss-120b rewrote untouched hyphens.
export const DEFAULT_PROPOSAL_MODEL = "@cf/moonshotai/kimi-k2.6";

type Overlap = Extract<Conflict, { kind: "overlap" }>;

const SYSTEM = `You merge two edits of one section of a markdown record into the version a careful editor would publish.
You get the section as it was (BASE), as one writer changed it (A), and as another writer changed it (B).
Keep every change each writer made on purpose: a fact one added, a wording one simplified, a correction. Say each fact once. Keep it about as long as the longer of A and B.
Reply with the merged section only: the same heading line if the inputs have one, then the text. No commentary, no code fences.`;

/** One merged section, or undefined when the model gives nothing usable (one retry). */
export async function proposeSection(ai: Ai, model: string, c: Overlap): Promise<string | undefined> {
  return (await proposeOnce(ai, model, c)) ?? (await proposeOnce(ai, model, c));
}

/** Paragraphs in a section, heading line excluded. */
const paragraphs = (t: string) => t.replace(/^## [^\n]*\n/, "").trim().split(/\n{2,}/).filter(Boolean).length;

async function proposeOnce(ai: Ai, model: string, c: Overlap): Promise<string | undefined> {
  const user = `BASE:\n${c.base}\n\nA:\n${c.ours}\n\nB:\n${c.theirs}`;
  const res = (await ai.run(model as keyof AiModels, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    max_tokens: 4096,
    chat_template_kwargs: { enable_thinking: false, thinking: false },
  } as never)) as { response?: string; choices?: { message?: { content?: string } }[] };
  let text = (res.response ?? res.choices?.[0]?.message?.content ?? "").trim();
  // Some models put their reasoning in the content, ending with </think>, even when told not to think.
  const think = text.lastIndexOf("</think>");
  if (think >= 0) text = text.slice(think + "</think>".length).trim();
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/, "$1").trim();
  if (!text) return undefined;
  // Keep the section's shape: its heading line, and the trailing blank line that separates sections.
  const heading = c.ours.split("\n")[0];
  if (heading.startsWith("## ") && !text.startsWith(heading)) return undefined;
  // Nothing but this section: no other heading, no frontmatter fence. Anything else would land unseen.
  const rest = heading.startsWith("## ") ? text.slice(heading.length) : text;
  if (/^#{1,6} |^---\s*$/m.test(rest)) return undefined;
  // More paragraphs than either writer produced is the model talking, not merging.
  if (paragraphs(text) > Math.max(paragraphs(c.ours), paragraphs(c.theirs))) return undefined;
  // One side repeated word for word is not a merge: approving it would quietly drop the other writer's edit.
  const body = (t: string) => t.replace(/^## [^\n]*\n/, "").trim();
  if (body(text) === body(c.ours) || body(text) === body(c.theirs)) return undefined;
  const tail = /\n*$/.exec(c.ours)?.[0] ?? "\n";
  return text + (tail || "\n");
}

/**
 * The record with every overlapping section taken from one side and everything else merged as
 * usual. "Keep main's" and "take the writer's" mean this, never the whole stale record: a side
 * choice must not undo other writers' clean changes elsewhere in the file. Undefined when a
 * conflict is not an overlap (a field, a delete, a move): those are whole-record choices.
 */
export function sideRecord(base: string | null, ours: string, theirs: string, side: "ours" | "theirs"): string | undefined {
  const r = mergeRecord({ base, ours, theirs }, (c) => pickSide(c.base, c.ours, c.theirs, side));
  return r.status === "clean" && r.content !== null ? r.content : undefined;
}

/** A whole proposed record: the clean merge with each overlapping section filled in, or undefined. */
export async function proposeRecord(ai: Ai, model: string, base: string | null, ours: string, theirs: string): Promise<string | undefined> {
  const first = mergeRecord({ base, ours, theirs });
  if (first.status === "clean") return first.content ?? undefined;
  if (first.conflicts.some((c) => c.kind !== "overlap")) return undefined; // fields, deletes and moves are a person's call
  const answers = new Map<string, string>();
  for (const c of first.conflicts) {
    if (c.kind !== "overlap") continue;
    const text = await proposeSection(ai, model, c);
    if (!text) return undefined;
    answers.set(c.section + "\u0000" + c.ours, text);
  }
  const r = mergeRecord({ base, ours, theirs }, (c) => answers.get(c.section + "\u0000" + c.ours));
  return r.status === "clean" && r.content !== null ? r.content : undefined;
}
