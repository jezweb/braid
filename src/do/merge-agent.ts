// One MergeAgent per canonical repo. G1: provisions lanes one at a time (concurrent
// fork() of one repo fails on Artifacts). G2 adds the merge queue and approvals.

import { DurableObject } from "cloudflare:workers";

export type LaneInfo = { laneName: string; remote: string; token: string; forkPoint: string };

type Env = { ARTIFACTS: Artifacts; MERGE_AGENT: DurableObjectNamespace<MergeAgent> };

export class MergeAgent extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  /** Serialise `f` behind every earlier call on this object. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Fork `<repo>--<agent>` if absent and return what the Lane needs. Idempotent, and safe to
   * re-run after a failure at any step: a fork that already exists is adopted, never re-made.
   */
  /** One MergeAgent per canonical repo: the object addressed by idFromName(repo), and no other. */
  private pin(repo: string) {
    if (!this.ctx.id.equals(this.env.MERGE_AGENT.idFromName(repo))) throw new Error(`this merge agent is not ${repo}'s`);
  }

  async provisionLane(repo: string, agent: string): Promise<LaneInfo> {
    this.pin(repo);
    const laneName = `${repo}--${agent}`;
    // A known lane only needs a fresh token: do not queue that behind forks (or, later, merges).
    const ready = await this.ctx.storage.get<{ forkPoint: string; remote: string }>(`lane:${agent}`);
    if (ready) {
      using lane = await this.env.ARTIFACTS.get(laneName);
      const t = await lane.createToken("write", 3600);
      return { laneName, remote: ready.remote, token: t.plaintext, forkPoint: ready.forkPoint };
    }
    return this.serial(async () => {
      let known = await this.ctx.storage.get<{ forkPoint: string; remote: string }>(`lane:${agent}`);
      if (!known) {
        await this.ctx.storage.put(`provisioning:${agent}`, Date.now());
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
        await this.ctx.storage.delete(`provisioning:${agent}`);
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
}
