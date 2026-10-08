// One MergeAgent per canonical repo: the only writer of main. It provisions
// lanes one at a time (concurrent fork() of one repo fails on Artifacts), keeps
// a queue of lanes with unmerged commits, folds them into main one lane at a
// time, and holds the approval record for every conflict.

import { DurableObject } from "cloudflare:workers";
import { parseMessage } from "../contract";
import type { Conflict } from "../merge";
import { mergeLane, type Override, type PathConflict } from "../merge-lane";
import { proposeRecord, sideRecord, DEFAULT_PROPOSAL_MODEL } from "../propose";
import type { Lane } from "./lane";

export type LaneInfo = { laneName: string; remote: string; token: string; forkPoint: string };

type Env = {
  ARTIFACTS: Artifacts;
  AI?: Ai;
  PROPOSAL_MODEL?: string;
  MERGE_AGENT: DurableObjectNamespace<MergeAgent>;
  LANE: DurableObjectNamespace<Lane>;
};

export type Approval = {
  id: number;
  agent: string;
  laneCommit: string;
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  baseText: string | null;
  oursText: string | null;
  theirsText: string | null;
  conflicts: Conflict[];
  proposal: string | null;
  proposalModel: string | null;
  status: "open" | "resolved" | "superseded" | "merged";
  resolution: "llm" | "human" | null;
  content: string | null;
  approvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

export type ResolveAction = "approve" | "ours" | "theirs" | "edit";

export type LaneStatus = { agent: string; since: string | null; dirty: number; merged: number; held: string | null; error: string | null };

export class MergeAgent extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS lanes (
        agent TEXT PRIMARY KEY, since TEXT, dirty INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0,
        held TEXT, error TEXT)`);
      // Added after the first deploy: the tip a sweep last queued, and consecutive fold failures.
      for (const col of ["swept TEXT", "fails INTEGER NOT NULL DEFAULT 0"]) {
        try { ctx.storage.sql.exec(`ALTER TABLE lanes ADD COLUMN ${col}`); } catch { /* already there */ }
      }
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, lane_commit TEXT NOT NULL, path TEXT NOT NULL,
        base TEXT, ours TEXT, theirs TEXT, base_text TEXT, ours_text TEXT, theirs_text TEXT, conflicts TEXT,
        proposal TEXT, proposal_model TEXT, status TEXT NOT NULL, resolution TEXT, content TEXT, approved_by TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER)`);
    });
  }

  /** Serialise `f` behind every earlier call on this object. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One MergeAgent per canonical repo: the object addressed by idFromName(repo), and no other. */
  private async pin(repo: string) {
    if (!this.ctx.id.equals(this.env.MERGE_AGENT.idFromName(repo))) throw new Error(`this merge agent is not ${repo}'s`);
    if (!(await this.ctx.storage.get<string>("repo"))) await this.ctx.storage.put("repo", repo);
  }

  // ---------------------------------------------------------------- lanes

  /**
   * Fork `<repo>--<agent>` if absent and return what the Lane needs. Idempotent, and safe to
   * re-run after a failure at any step: a fork that already exists is adopted, never re-made.
   */
  async provisionLane(repo: string, agent: string): Promise<LaneInfo> {
    await this.pin(repo);
    const laneName = `${repo}--${agent}`;
    // A known lane only needs a fresh token: do not queue that behind forks or merges.
    const ready = await this.ctx.storage.get<{ forkPoint: string; remote: string }>(`lane:${agent}`);
    if (ready) {
      using lane = await this.env.ARTIFACTS.get(laneName);
      const t = await lane.createToken("write", 3600);
      return { laneName, remote: ready.remote, token: t.plaintext, forkPoint: ready.forkPoint };
    }
    return this.serial(async () => {
      let known = await this.ctx.storage.get<{ forkPoint: string; remote: string }>(`lane:${agent}`);
      if (!known) {
        if (!(await this.exists(laneName))) {
          using canonical = await this.env.ARTIFACTS.get(repo);
          await canonical.fork(laneName, { defaultBranchOnly: true });
        }
        using lane = await this.waitReady(laneName);
        const info = await lane.info();
        if (info.source && !info.source.endsWith(`/${repo}`)) throw new Error(`${laneName} is a fork of ${info.source}, not ${repo}`);
        // The fork point is the newest lane commit main also has: the fork's head when fresh,
        // or older when an earlier attempt already wrote to the lane.
        using canonical = await this.env.ARTIFACTS.get(repo);
        let forkPoint: string | undefined;
        for (const c of await lane.log({ ref: "main", limit: 1000 })) {
          if (await canonical.readCommit(c.hash)) { forkPoint = c.hash; break; }
        }
        if (!forkPoint) throw new Error(`${laneName} shares no commit with ${repo}`);
        known = { forkPoint, remote: info.remote };
        await this.ctx.storage.put(`lane:${agent}`, known);
        this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO lanes (agent, since) VALUES (?, ?)`, agent, forkPoint);
      }
      using lane = await this.env.ARTIFACTS.get(laneName);
      const t = await lane.createToken("write", 3600);
      return { laneName, remote: known.remote, token: t.plaintext, forkPoint: known.forkPoint };
    });
  }

  private async exists(name: string): Promise<boolean> {
    try {
      using r = await this.env.ARTIFACTS.get(name);
      return true;
    } catch (e) {
      if (/NOT_FOUND|not found|does not exist/i.test(String(e))) return false;
      if (/FORK_IN_PROGRESS|not ready/i.test(String(e))) return true;
      throw e;
    }
  }

  private async waitReady(name: string): Promise<ArtifactsRepo> {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await this.env.ARTIFACTS.get(name);
        await r.info();
        return r;
      } catch (e) {
        if (Date.now() - t0 > 60_000) throw e;
        await new Promise((ok) => setTimeout(ok, 250));
      }
    }
  }

  // ---------------------------------------------------------------- queue

  /** A lane has a new commit: queue it. Cheap; the merge happens in the alarm. */
  async notify(repo: string, agent: string): Promise<void> {
    await this.pin(repo);
    this.ctx.storage.sql.exec(`INSERT INTO lanes (agent, dirty) VALUES (?, 1) ON CONFLICT(agent) DO UPDATE SET dirty = dirty + 1`, agent);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  /**
   * Watch every lane for `seconds`: agents that push with plain git tell nobody, so the merger
   * looks at each lane's head every few seconds and queues any that moved.
   */
  async watch(repo: string, seconds: number): Promise<void> {
    await this.pin(repo);
    if (!(seconds > 0)) throw new Error("seconds must be positive");
    // A shorter request never cuts short a longer watch already running.
    const until = Math.max((await this.ctx.storage.get<number>("sweepUntil")) ?? 0, Date.now() + Math.min(seconds, 3600) * 1000);
    await this.ctx.storage.put("sweepUntil", until);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  private async sweep(repo: string) {
    const lanes = this.ctx.storage.sql.exec<{ agent: string; since: string | null; held: string | null; swept: string | null }>(`SELECT agent, since, held, swept FROM lanes`).toArray();
    for (const l of lanes) {
      try {
        using r = await this.env.ARTIFACTS.get(`${repo}--${l.agent}`);
        const head = (await r.log({ ref: "main", limit: 1 }))[0]?.hash;
        // Queue a lane once per new tip: a tip stuck behind a held commit is not re-folded every sweep.
        if (head && head !== l.since && head !== l.held && head !== l.swept) {
          this.ctx.storage.sql.exec(`UPDATE lanes SET dirty = dirty + 1, swept = ? WHERE agent = ?`, head, l.agent);
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "sweep_failed", agent: l.agent, error: String(e) }));
      }
    }
  }

  async alarm(): Promise<void> {
    try {
      const until = (await this.ctx.storage.get<number>("sweepUntil")) ?? 0;
      // Sweep and drain in one turn of the serial chain: a sweep's dirty update can never interleave with a fold's.
      await this.serial(async () => {
        if (until > Date.now()) await this.sweep((await this.ctx.storage.get<string>("repo"))!);
        await this.drain();
      });
      if (until > Date.now() && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 5000);
      await this.ctx.storage.delete("alarmRetries");
    } catch (err) {
      // An alarm that throws stops the chain: retry with backoff, a bounded number of times.
      const retries = (await this.ctx.storage.get<number>("alarmRetries")) ?? 0;
      console.error(JSON.stringify({ event: "merge_alarm_error", retries, error: String(err) }));
      if (retries < 6) {
        await this.ctx.storage.put("alarmRetries", retries + 1);
        await this.ctx.storage.setAlarm(Date.now() + 2000 * 2 ** retries);
      }
    }
  }

  /**
   * One pass over every dirty lane, in turn (a busy lane cannot starve the rest). A lane that
   * fails waits for the next alarm; the others go on. Owed acks to Lanes are retried first.
   */
  private async drain() {
    const repo = (await this.ctx.storage.get<string>("repo"))!;
    await this.retryAcks(repo);
    const dirty = this.ctx.storage.sql.exec<{ agent: string; dirty: number }>(`SELECT agent, dirty FROM lanes WHERE dirty > 0 ORDER BY agent`).toArray();
    let failed = 0;
    for (const row of dirty) {
      try {
        await this.foldLane(repo, row.agent);
        // Clear only the notifications we have seen: a write that arrived meanwhile keeps the lane dirty.
        this.ctx.storage.sql.exec(`UPDATE lanes SET dirty = MAX(dirty - ?, 0), fails = 0 WHERE agent = ?`, row.dirty, row.agent);
      } catch (err) {
        failed++;
        // Five failures in a row (say, history rewritten so it no longer reaches `since`): stop retrying
        // that lane until something new arrives on it. The error stays on the lane for a person to see.
        this.ctx.storage.sql.exec(
          `UPDATE lanes SET error = ?, fails = fails + 1, dirty = CASE WHEN fails + 1 >= 5 THEN 0 ELSE dirty END WHERE agent = ?`,
          String(err).slice(0, 500), row.agent,
        );
        console.error(JSON.stringify({ event: "fold_failed", agent: row.agent, error: String(err) }));
      }
    }
    const more = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM lanes WHERE dirty > 0`).one().n;
    const owed = (await this.ctx.storage.list({ prefix: "ack:" })).size;
    if (more || owed) await this.ctx.storage.setAlarm(Date.now() + (failed || (!more && owed) ? 5000 : 200));
  }

  /** Tell a Lane its commits are on main. Kept as owed until the Lane has it. */
  private async ack(repo: string, agent: string, commits: string[]) {
    const owed = [...((await this.ctx.storage.get<string[]>(`ack:${agent}`)) ?? []), ...commits];
    try {
      await this.env.LANE.get(this.env.LANE.idFromName(`${repo}:${agent}`)).merged(owed);
      await this.ctx.storage.delete(`ack:${agent}`);
    } catch (e) {
      await this.ctx.storage.put(`ack:${agent}`, owed.slice(-5000));
      console.error(JSON.stringify({ event: "lane_merged_ack_failed", agent, error: String(e) }));
    }
  }

  private async retryAcks(repo: string) {
    for (const key of (await this.ctx.storage.list({ prefix: "ack:" })).keys()) await this.ack(repo, key.slice(4), []);
  }

  private async foldLane(repo: string, agent: string) {
    const laneName = `${repo}--${agent}`;
    const lane = this.ctx.storage.sql.exec<{ since: string | null }>(`SELECT since FROM lanes WHERE agent = ?`, agent).toArray()[0];
    const known = await this.ctx.storage.get<{ forkPoint: string; remote: string }>(`lane:${agent}`);
    if (!known) return; // not provisioned through us: nothing we can fetch
    using canonical = await this.env.ARTIFACTS.get(repo);
    using laneRepo = await this.env.ARTIFACTS.get(laneName);
    // What main already names, so a commit whose bookkeeping we lost is never folded twice.
    // Known limit: only the newest 1,000 main commits are read, so this guards a lost `since`
    // only while fewer than 1,000 merges have landed since; `since` itself is the main guard.
    const onMain = new Set<string>();
    let since = lane?.since ?? known.forkPoint;
    for (const c of await canonical.log({ ref: "main", limit: 1000 })) {
      const t = parseMessage(c.message).trailers;
      if (t.laneCommit && t.agent === agent) onMain.add(t.laneCommit);
    }
    // Tokens are reused until close to expiry: minting is itself a metered event (token_create).
    const ct = await this.token(canonical, `tok:canonical`, "write");
    const lt = await this.token(laneRepo, `tok:lane:${agent}`, "read");
    const canonicalInfo = await this.canonicalInfo(canonical);
    const result = await mergeLane(
      { url: canonicalInfo.remote, token: ct.plaintext },
      { url: known.remote, token: lt.plaintext },
      { since, onMain, agent, overrides: (laneCommit, path) => this.override(laneCommit, path), attempts: 5 },
    );

    const mergedNow = result.outcomes.filter((o) => o.status === "merged").map((o) => o.laneCommit);
    // Folded = merged by this run, or found already on main (its bookkeeping was lost). Both advance `since`.
    const folded = [...result.skipped, ...mergedNow];
    if (folded.length) since = folded[folded.length - 1];
    let held: string | null = null;
    const stop = result.outcomes.at(-1);
    if (stop?.status === "conflict") {
      held = stop.laneCommit;
      for (const pc of stop.conflicts) await this.openApproval(agent, stop.laneCommit, pc);
      // Paths of the held commit that no longer conflict: their old rows are obsolete.
      const paths = JSON.stringify(stop.conflicts.map((c) => c.path));
      this.ctx.storage.sql.exec(
        `UPDATE approvals SET status = 'superseded' WHERE agent = ? AND lane_commit = ? AND status = 'open' AND path NOT IN (SELECT value FROM json_each(?))`,
        agent, stop.laneCommit, paths,
      );
    } else if (stop?.status === "invalid") {
      held = stop.laneCommit;
      this.ctx.storage.sql.exec(`UPDATE lanes SET error = ? WHERE agent = ?`, `invalid ${stop.laneCommit}: ${stop.errors.join("; ")}`.slice(0, 500), agent);
    }
    // Owe the Lane its ack before `since` moves past these commits, so a crash between cannot lose it.
    if (folded.length) await this.ctx.storage.put(`ack:${agent}`, [...((await this.ctx.storage.get<string[]>(`ack:${agent}`)) ?? []), ...folded].slice(-5000));
    this.ctx.storage.sql.exec(`UPDATE lanes SET since = ?, held = ?, merged = merged + ? WHERE agent = ?`, since, held, mergedNow.length, agent);
    if (stop?.status !== "invalid") this.ctx.storage.sql.exec(`UPDATE lanes SET error = NULL WHERE agent = ?`, agent);
    // Every approval for a folded commit is done; any other open row of this agent not for the held commit is obsolete.
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = 'merged' WHERE agent = ? AND status IN ('open', 'resolved') AND lane_commit IN (SELECT value FROM json_each(?))`,
      agent, JSON.stringify(folded),
    );
    this.ctx.storage.sql.exec(`UPDATE approvals SET status = 'superseded' WHERE agent = ? AND status = 'open' AND lane_commit IS NOT ?`, agent, held);
    if (folded.length) await this.ack(repo, agent, []);
  }

  private tokens = new Map<string, { plaintext: string; until: number }>();
  private info?: ArtifactsRepoInfo;

  private async token(repo: ArtifactsRepo, key: string, scope: "read" | "write") {
    const t = this.tokens.get(key);
    if (t && t.until - Date.now() > 120_000) return t;
    const fresh = await repo.createToken(scope, 900);
    const v = { plaintext: fresh.plaintext, until: Date.now() + 900_000 };
    this.tokens.set(key, v);
    return v;
  }

  private async canonicalInfo(repo: ArtifactsRepo) {
    this.info ??= await repo.info();
    return this.info;
  }

  // ---------------------------------------------------------------- approvals

  private override(laneCommit: string, path: string): Override | undefined {
    const row = this.ctx.storage.sql
      .exec<{ ours: string | null; content: string | null; resolution: "llm" | "human"; approved_by: string }>(
        `SELECT ours, content, resolution, approved_by FROM approvals WHERE lane_commit = ? AND path = ? AND status = 'resolved' ORDER BY id DESC LIMIT 1`,
        laneCommit, path,
      )
      .toArray()[0];
    return row ? { ours: row.ours, content: row.content, resolution: row.resolution, approvedBy: row.approved_by } : undefined;
  }

  /** Open (or keep) the approval for one conflicted path. A row found against an older main is superseded. */
  private async openApproval(agent: string, laneCommit: string, pc: PathConflict) {
    const existing = this.ctx.storage.sql
      .exec<{ id: number; ours: string | null; status: string }>(
        `SELECT id, ours, status FROM approvals WHERE lane_commit = ? AND path = ? AND status IN ('open', 'resolved') ORDER BY id DESC LIMIT 1`,
        laneCommit, pc.path,
      )
      .toArray()[0];
    // Still the same question (main unchanged): keep it, open or already answered (a resolve raced this fold).
    if (existing && existing.ours === pc.ours) {
      if (existing.status === "resolved") await this.notify((await this.ctx.storage.get<string>("repo"))!, agent);
      return;
    }
    if (existing) this.ctx.storage.sql.exec(`UPDATE approvals SET status = 'superseded' WHERE id = ?`, existing.id);

    let proposal: string | undefined;
    const model = this.env.PROPOSAL_MODEL || DEFAULT_PROPOSAL_MODEL;
    if (this.env.AI && pc.oursText !== null && pc.theirsText !== null) {
      proposal = await proposeRecord(this.env.AI, model, pc.baseText, pc.oursText, pc.theirsText).catch((e) => {
        console.error(JSON.stringify({ event: "proposal_failed", agent, path: pc.path, error: String(e) }));
        return undefined;
      });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO approvals (agent, lane_commit, path, base, ours, theirs, base_text, ours_text, theirs_text, conflicts, proposal, proposal_model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      agent, laneCommit, pc.path, pc.base, pc.ours, pc.theirs, pc.baseText, pc.oursText, pc.theirsText,
      JSON.stringify(pc.conflicts), proposal ?? null, proposal ? model : null, Date.now(),
    );
  }

  async approvals(status: "open" | "all" = "open"): Promise<Approval[]> {
    return this.rows(status === "open" ? `SELECT * FROM approvals WHERE status = 'open' ORDER BY id` : `SELECT * FROM approvals ORDER BY id DESC LIMIT 200`);
  }

  async approval(id: number): Promise<Approval | undefined> {
    return this.rows(`SELECT * FROM approvals WHERE id = ?`, id)[0];
  }

  private rows(sql: string, ...args: (string | number)[]): Approval[] {
    const rows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(sql, ...args).toArray();
    return rows.map((r) => ({
      id: r.id as number, agent: r.agent as string, laneCommit: r.lane_commit as string, path: r.path as string,
      base: r.base as string | null, ours: r.ours as string | null, theirs: r.theirs as string | null,
      baseText: r.base_text as string | null, oursText: r.ours_text as string | null, theirsText: r.theirs_text as string | null,
      conflicts: JSON.parse((r.conflicts as string) ?? "[]"), proposal: r.proposal as string | null, proposalModel: r.proposal_model as string | null,
      status: r.status as Approval["status"], resolution: r.resolution as Approval["resolution"], content: r.content as string | null,
      approvedBy: r.approved_by as string | null, createdAt: r.created_at as number, resolvedAt: r.resolved_at as number | null,
    }));
  }

  /** The open approval for one agent's path, if any: how a Lane tells its agent a write is waiting on a person. */
  async approvalFor(agent: string, path: string): Promise<{ id: number; laneCommit: string } | undefined> {
    return this.ctx.storage.sql
      .exec<{ id: number; laneCommit: string }>(`SELECT id, lane_commit AS laneCommit FROM approvals WHERE agent = ? AND path = ? AND status = 'open' ORDER BY id DESC LIMIT 1`, agent, path)
      .toArray()[0];
  }

  /** A person's answer. The merge applies it only while main still holds what they saw. */
  async resolve(repo: string, id: number, action: ResolveAction, by: string, text?: string): Promise<Approval> {
    await this.pin(repo);
    // In the serial chain, so an answer never lands in the middle of a fold.
    return this.serial(() => this.resolveNow(repo, id, action, by, text));
  }

  private async resolveNow(repo: string, id: number, action: ResolveAction, by: string, text?: string): Promise<Approval> {
    const a = await this.approval(id);
    if (!a) throw new Error(`no approval ${id}`);
    if (a.status !== "open") throw new Error(`approval ${id} is ${a.status}`);
    // A side applies to the overlapping sections only; the rest of the record keeps every clean change.
    const side = (which: "ours" | "theirs") =>
      a.oursText !== null && a.theirsText !== null
        ? (sideRecord(a.baseText, a.oursText, a.theirsText, which) ?? (which === "ours" ? a.oursText : a.theirsText))
        : which === "ours" ? a.oursText : a.theirsText;
    const content = action === "approve" ? a.proposal : action === "ours" ? side("ours") : action === "theirs" ? side("theirs") : (text ?? null);
    if (action === "approve" && content === null) throw new Error(`approval ${id} has no proposal to approve`);
    if (action === "edit" && typeof text !== "string") throw new Error("edit needs text");
    const resolution = action === "approve" ? "llm" : "human";
    this.ctx.storage.sql.exec(
      `UPDATE approvals SET status = 'resolved', resolution = ?, content = ?, approved_by = ?, resolved_at = ? WHERE id = ?`,
      resolution, content, by, Date.now(), id,
    );
    await this.notify(repo, a.agent);
    return (await this.approval(id))!;
  }

  /** Forget everything (the demo rebuilds its repo under the same name). Returns the agents it knew. */
  reset(repo: string): Promise<string[]> {
    return this.serial(async () => {
      if (!this.ctx.id.equals(this.env.MERGE_AGENT.idFromName(repo))) throw new Error(`this merge agent is not ${repo}'s`);
      const agents = this.ctx.storage.sql.exec<{ agent: string }>(`SELECT agent FROM lanes`).toArray().map((r) => r.agent);
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec(`DELETE FROM lanes`);
      this.ctx.storage.sql.exec(`DELETE FROM approvals`);
      // The act log outlives a rebuild: it is the record of who decided what, and how they signed in.
      await this.ctx.storage.delete([...(await this.ctx.storage.list()).keys()].filter((k) => k !== "actlog"));
      this.tokens.clear();
      this.info = undefined;
      return agents;
    });
  }

  /** The last 50 attempts to act (approve, undo): who, whether a sign-in token came and verified, the answer. */
  async logAct(entry: { at: number; path: string; token: boolean; why?: string; actor: string | null; status: number; note?: string }): Promise<void> {
    const log = (await this.ctx.storage.get<typeof entry[]>("actlog")) ?? [];
    log.push(entry);
    await this.ctx.storage.put("actlog", log.slice(-50));
  }

  async actLog(): Promise<unknown[]> {
    return (await this.ctx.storage.get<unknown[]>("actlog")) ?? [];
  }

  async status(): Promise<{ lanes: LaneStatus[]; open: number; alarm: number | null }> {
    const lanes = this.ctx.storage.sql.exec<LaneStatus>(`SELECT agent, since, dirty, merged, held, error FROM lanes ORDER BY agent`).toArray();
    const open = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'open'`).one().n;
    return { lanes, open, alarm: await this.ctx.storage.getAlarm() };
  }
}
