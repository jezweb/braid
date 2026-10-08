// The demo, end to end: five LLM agents write a made-up town's knowledge base at
// once, the merge agent folds their lanes, one real overlap waits for a person, a
// mistaken delete is undone (and the undo undone), and a plain-git agent pushes.
//
// mode "unattended": the runner plays the person too (G4: ten runs, no repair).
// mode "interactive": the runner waits for a person to approve and undo on the viewer.
//
// Models write only prose (a sentence, a paragraph); code assembles the records, so a
// model can never break a record's shape. Every fallback to canned text is reported.

import { parseMessage, type Envelope } from "./contract";
import { Store } from "./git/store";
import { revertEnvelope } from "./primitives";
import type { Lane } from "./do/lane";
import type { MergeAgent } from "./do/merge-agent";

type Env = {
  ARTIFACTS: Artifacts;
  AI?: Ai;
  LANE: DurableObjectNamespace<Lane>;
  MERGE_AGENT: DurableObjectNamespace<MergeAgent>;
  PERSON_AGENT?: string;
};

const MODEL = "@cf/moonshotai/kimi-k2.6";
const AGENTS = ["scout", "fact-checker", "editor", "translator", "archivist"] as const;
const PLAIN = "claude-code";

const TOWN = "towns/harbourne.md";
const ADA = "people/ada-quill.md";
const SEED: Record<string, string> = {
  [TOWN]: `---
title: Harbourne
status: draft
---
# Harbourne

## Summary

Harbourne is a made-up river town of about 4,000 people, with one stone bridge, a flour mill and a Saturday market.

## History

Founded in 1851 by fictional settlers who dammed the creek to power the mill.

## Contacts

Town hall: 555 0100
`,
  [ADA]: `---
title: Ada Quill
role: Harbourne mill manager
---
# Ada Quill

Runs the flour mill and the Saturday market roster.

Phone: 555 0100
`,
  "places/mill.md": `# The Mill\n\nA working flour mill on the creek, built 1852.\n`,
};

export type ScenarioResult = {
  pass: boolean;
  repo: string;
  mode: string;
  ms: number;
  checks: Record<string, boolean>;
  fallbacks: string[];
  approvals: number;
  /** Times the one conflict was asked again because main moved under an open approval. */
  reasked?: number;
  merges: number;
  steps: { step: string; ms: number }[];
  town?: string;
  error?: string;
};

/**
 * phase "all" (default) sets the stage and plays; "stage" only rebuilds, seeds and forks every lane (the slow
 * part, about 35 s), so filming can start on a ready stage; "play" runs the acts on a stage already set.
 */
export async function runScenario(env: Env, opts: { repo: string; mode?: "unattended" | "interactive"; personWaitMs?: number; phase?: "all" | "stage" | "play"; paceMs?: number }): Promise<ScenarioResult> {
  const phase = opts.phase ?? "all";
  // Unattended, the runner stands in for the person; paceMs makes it wait before each decision, so a
  // recording can show the question and the record before the answer lands.
  const pace = () => new Promise((r) => setTimeout(r, Math.min(opts.paceMs ?? 0, 60_000)));
  const { repo } = opts;
  const mode = opts.mode ?? "unattended";
  const person = env.PERSON_AGENT ?? "person";
  const t0 = Date.now();
  const steps: ScenarioResult["steps"] = [];
  const mark = (step: string) => steps.push({ step, ms: Date.now() - t0 });
  const fallbacks: string[] = [];
  let reasked = 0;
  const checks: Record<string, boolean> = {};
  const lane = (agent: string) => env.LANE.get(env.LANE.idFromName(`${repo}:${agent}`));
  const ma = env.MERGE_AGENT.get(env.MERGE_AGENT.idFromName(repo));
  const write = (agent: string, e: Omit<Envelope, "agent">) => lane(agent).write(repo, { ...e, agent });
  const read = (agent: string, path: string) => lane(agent).read(repo, agent, path);
  const drained = async (limitMs = 120_000) => {
    const start = Date.now();
    for (;;) {
      const s = await ma.status();
      if (s.alarm === null && s.lanes.every((l) => l.dirty === 0)) return s;
      if (Date.now() - start > limitMs) throw new Error(`queue not drained after ${limitMs} ms`);
      await sleep(500);
    }
  };
  const mainLog = async () => {
    using r = await env.ARTIFACTS.get(repo);
    return (await r.log({ ref: "main", limit: 200 })).map((c) => ({ hash: c.hash, ...parseMessage(c.message) }));
  };
  const say = (persona: string, task: string, fallback: string) => prose(env.AI, persona, task).then((t) => t ?? (fallbacks.push(persona.split(" ")[0]), fallback));

  try {
    // ---- the stage: a fresh repo, every lane forked in advance (forks take seconds each)
    if (phase === "play") {
      // The stage must be fresh: the seed commit and nothing else on main.
      const log = await mainLog().catch(() => []);
      if (log.length !== 1) throw new Error(`play needs a freshly staged repo (main has ${log.length} commits); run phase=stage first`);
      for (const a of [...AGENTS, person, PLAIN]) await ma.provisionLane(repo, a);
      await ma.watch(repo, 600);
      mark("stage found");
    } else {
      await rebuild(env, repo, [...AGENTS, person, PLAIN]);
      const created = await createRepo(env.ARTIFACTS, repo);
      const seed = await Store.open();
      const edits = new Map<string, string>();
      for (const [p, text] of Object.entries(SEED)) edits.set(p, await seed.writeText(text));
      const tree = await seed.editTree(null, edits);
      await seed.push({ url: created.remote, token: created.token }, await seed.commit({ tree, parents: [], message: "Harbourne: first records", author: { name: "seed", email: "seed@braid.invalid" } }));
      for (const a of [...AGENTS, person, PLAIN]) await ma.provisionLane(repo, a);
      await ma.watch(repo, 600);
      mark("stage set");
      if (phase === "stage") return { pass: true, repo, mode, ms: Date.now() - t0, checks: { staged: true }, fallbacks, approvals: 0, merges: 0, steps };
    }

    // ---- act 1: everyone reads, then everyone writes at once
    const [town0, ada0] = await Promise.all([read("editor", TOWN), read("fact-checker", ADA)]);
    const townT = await read("translator", TOWN);
    const summary0 = section(town0.content!, "Summary");
    const [scoutText, editorText, translatorText] = await Promise.all([
      say("Scout, a field researcher for a town knowledge base.", "Write two plain sentences describing the Harbourne Saturday market: where it is held and what is sold. Made-up details only; any phone number must start 555.", "The Saturday market fills the square beside the mill from 7am. Stalls sell bread from the mill's flour, river fish and secondhand books."),
      say("Editor, who tightens prose for a town knowledge base.", `Rewrite this paragraph to be shorter and clearer, keeping every fact:\n\n${summary0}`, "Harbourne is a made-up river town of 4,000 with a stone bridge, a flour mill and a Saturday market."),
      say("Translator, who rewrites knowledge-base text in plain English for new readers.", `Rewrite this paragraph in plain English for someone new to the town, keeping every fact:\n\n${summary0}`, "About 4,000 people live in Harbourne, a made-up town on a river. It has one stone bridge, a mill that makes flour, and a market every Saturday."),
    ]);
    mark("agents wrote their drafts");
    const results = await Promise.allSettled([
      write("scout", { reason: "Add the Saturday market", source: "walked the market, made-up notes", changes: [{ path: "places/market.md", base: null, content: `# Saturday Market\n\n${scoutText}\n` }] }),
      write("fact-checker", { reason: "Fix Ada Quill's phone", source: "town directory, page 3 (made up)", changes: [{ path: ADA, base: ada0.base, content: ada0.content!.replace("555 0100", "555 0142") }] }),
      write("editor", { reason: "Tighten the summary", changes: [{ path: TOWN, base: town0.base, content: replaceSection(town0.content!, "Summary", editorText) }] }),
      write("translator", { reason: "Summary in plain English", changes: [{ path: TOWN, base: townT.base, content: replaceSection(townT.content!, "Summary", translatorText) }] }),
    ]);
    // The editor writes again before its first write merges: from its own pending version.
    const town1 = await read("editor", TOWN);
    // The editor's second write starts from its own first write: still pending, or already merged into main.
    checks.stackedReadsOwnWrite = town1.pending || (town1.content ?? "").includes(editorText);
    await write("editor", { reason: "Date the bridge", changes: [{ path: TOWN, base: town1.base, content: town1.content!.replace("Founded in 1851", "Founded in 1851 (the stone bridge followed in 1860)") }] });
    checks.allWritesLanded = results.every((r) => r.status === "fulfilled");
    mark("act 1 written");
    await drained();
    mark("act 1 merged");

    // ---- act 2: the one real overlap waits for a person
    // One real conflict, but possibly more than one question: if main moves after an approval opens (the
    // editor's stacked write merging), the answer is refused against the stale main and the question is
    // asked again. A person sees the new question; the unattended runner answers it too.
    const open = await ma.approvals("open");
    checks.exactlyOneConflict = open.length === 1 && open[0].path === TOWN;
    checks.approvalHasProposal = !!open[0]?.proposal;
    const conflicted = open[0]?.laneCommit;
    let asked = 0;
    for (let round = 0; conflicted && round < 4; round++) {
      const q = (await ma.approvals("open")).find((a) => a.laneCommit === conflicted);
      if (!q) break;
      asked++;
      if (mode === "unattended") {
        await pace();
        await ma.resolve(repo, q.id, q.proposal ? "approve" : "theirs", "scenario@braid.invalid");
      } else await until(async () => (await ma.approval(q.id))?.status !== "open", opts.personWaitMs ?? 600_000);
      await drained();
    }
    reasked = Math.max(0, asked - 1);
    checks.onlyThatConflictAsked = (await ma.approvals("all")).every((a) => a.laneCommit === conflicted);
    const afterApproval = await mainLog();
    // The editor's stacked write (the bridge date, in History) merged without asking anyone.
    checks.stackedMergedClean = (await mainText(env, repo, TOWN)).includes("1860");
    checks.approvalLanded = afterApproval.some((c) => c.trailers.approvedBy && c.trailers.laneCommit && (c.trailers.resolution === "llm" || c.trailers.resolution === "human"));
    mark("act 2 approved");

    // ---- act 3: a mistaken delete, undone, and the undo undone
    const beforeDelete = await mainText(env, repo, TOWN);
    const town2 = await read("archivist", TOWN);
    await write("archivist", { reason: "Tidy the town record", changes: [{ path: TOWN, base: town2.base, content: dropSection(town2.content!, "History") }] });
    await drained();
    const deleted = (await mainLog())[0];
    const afterDelete = await mainText(env, repo, TOWN);
    checks.deleteLanded = deleted.trailers.agent === "archivist" && !afterDelete.includes("## History") && afterDelete.length > 0;
    if (mode === "unattended") {
      await pace();
      const e = await revertEnvelope(env.ARTIFACTS, repo, person, deleted.hash, TOWN);
      await write(person, { ...e, source: "undo by scenario@braid.invalid" });
      await drained();
    } else {
      await until(async () => (await mainLog()).some((c) => c.trailers.reverts === deleted.hash), opts.personWaitMs ?? 600_000);
    }
    const undo = (await mainLog()).find((c) => c.trailers.reverts === deleted.hash);
    // The whole record, not a heading: undo gives back exactly what the delete took.
    checks.undoRestored = !!undo && (await mainText(env, repo, TOWN)) === beforeDelete;
    if (mode === "unattended" && undo) {
      await pace();
      const e = await revertEnvelope(env.ARTIFACTS, repo, person, undo.hash, TOWN);
      await write(person, { ...e, source: "undo by scenario@braid.invalid" });
      await drained();
    } else if (undo) {
      await until(async () => (await mainLog()).some((c) => c.trailers.reverts === undo.hash), opts.personWaitMs ?? 600_000);
    }
    checks.undoOfUndoReapplied = (await mainText(env, repo, TOWN)) === afterDelete;
    mark("act 3 undo and undo of undo");

    // ---- act 4: an agent that only knows git
    if (mode === "unattended") await pace();
    const info = await ma.provisionLane(repo, PLAIN);
    const g = await Store.open();
    const tip = (await g.fetch({ url: info.remote, token: info.token }, "main", 1))!;
    const gt = await g.editTree((await g.readCommit(tip)).tree, new Map([["places/mill-cafe.md", await g.writeText("# The Mill Café\n\nA made-up café beside the mill. Phone: 555 0177.\n")]]));
    await g.push({ url: info.remote, token: info.token }, await g.commit({ tree: gt, parents: [tip], message: "Add the Mill Café", author: { name: PLAIN, email: `${PLAIN}@braid.invalid` } }));
    await until(async () => (await mainLog())[0]?.trailers.agent === PLAIN, 60_000);
    await drained();
    checks.plainGitMerged = (await mainLog()).some((c) => c.trailers.agent === PLAIN && c.trailers.source === "git push") &&
      (await mainText(env, repo, "places/mill-cafe.md")).includes("Mill Café");
    mark("act 4 plain git");

    // ---- the closer: what main says now
    const log = await mainLog();
    const merges = log.filter((c) => c.trailers.laneCommit);
    const town = await mainText(env, repo, TOWN);
    checks.phoneFixed = (await mainText(env, repo, ADA)).includes("555 0142");
    checks.marketAdded = (await mainText(env, repo, "places/market.md")).includes("Saturday Market");
    // Lane commits written: scout, fact-checker, editor x2, translator, archivist, person x2, claude-code = 9.
    checks.mergesAccountForWrites = merges.length === 9 && new Set(merges.map((c) => c.trailers.laneCommit)).size === 9;
    const allApprovals = await ma.approvals("all");
    const pass = Object.values(checks).every(Boolean);
    return { pass, repo, mode, ms: Date.now() - t0, checks, fallbacks, approvals: allApprovals.length, reasked, merges: merges.length, steps, town };
  } catch (e) {
    console.error(JSON.stringify({ event: "scenario_failed", repo, error: String(e), stack: (e as Error).stack }));
    return { pass: false, repo, mode, ms: Date.now() - t0, checks, fallbacks, approvals: -1, merges: -1, steps, error: String(e) };
  }
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function until(f: () => Promise<boolean>, limitMs: number) {
  const start = Date.now();
  while (!(await f())) {
    if (Date.now() - start > limitMs) throw new Error(`waited ${limitMs} ms`);
    await sleep(1000);
  }
}

/** One short piece of prose from a model, or undefined (the caller uses canned text and reports it). */
async function prose(ai: Ai | undefined, persona: string, task: string): Promise<string | undefined> {
  if (!ai) return undefined;
  try {
    const res = (await ai.run(MODEL as keyof AiModels, {
      messages: [
        { role: "system", content: `You are ${persona} Reply with the text only: no heading, no quotes, no commentary. Plain sentences, no markdown.` },
        { role: "user", content: task },
      ],
      max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false, thinking: false },
    } as never)) as { response?: string; choices?: { message?: { content?: string } }[] };
    let t = (res.response ?? res.choices?.[0]?.message?.content ?? "").trim();
    const think = t.lastIndexOf("</think>");
    if (think >= 0) t = t.slice(think + 8).trim();
    t = t.replace(/^["']|["']$/g, "").replace(/\n{2,}/g, " ").replace(/^#+ .*\n/, "").trim();
    // A paragraph, not an essay; and no line that could pass for a heading or frontmatter.
    if (!t || t.length > 600 || /^(#|---)/m.test(t)) return undefined;
    return t;
  } catch {
    return undefined;
  }
}

function section(record: string, name: string): string {
  const m = new RegExp(`## ${name}\\n\\n([\\s\\S]*?)\\n(?:\\n## |$)`).exec(record);
  return m ? m[1].trim() : "";
}

function replaceSection(record: string, name: string, text: string): string {
  return record.replace(new RegExp(`(## ${name}\\n\\n)[\\s\\S]*?(\\n\\n## |\\n$)`), (_m, head, tail) => `${head}${text}${tail}`);
}

function dropSection(record: string, name: string): string {
  return record.replace(new RegExp(`## ${name}\\n\\n[\\s\\S]*?\\n\\n(?=## )`), "");
}

async function mainText(env: Env, repo: string, path: string): Promise<string> {
  using r = await env.ARTIFACTS.get(repo);
  const f = await r.readFile({ ref: "main", path });
  return f ? f.text() : "";
}

async function createRepo(artifacts: Artifacts, repo: string): Promise<ArtifactsCreateRepoResult> {
  for (let i = 0; ; i++) {
    try { return await artifacts.create(repo, { setDefaultBranch: "main" }); }
    catch (e) { if (i >= 5) throw e; await sleep(1000 * (i + 1)); }
  }
}

/** Forget every Durable Object's state for this repo and delete its repos, so a run starts clean. */
async function rebuild(env: Env, repo: string, agents: string[]) {
  const ma = env.MERGE_AGENT.get(env.MERGE_AGENT.idFromName(repo));
  const known = await ma.reset(repo);
  for (const a of new Set([...known, ...agents])) {
    await env.LANE.get(env.LANE.idFromName(`${repo}:${a}`)).reset();
    await env.ARTIFACTS.delete(`${repo}--${a}`).catch(() => false);
  }
  await env.ARTIFACTS.delete(repo).catch(() => false);
}
