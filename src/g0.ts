// G0 on real Artifacts, entirely inside one Worker request: create canonical,
// seed it, fork it, advance main twice, commit on the fork, fold the fork into
// main with mergeLane, then read main back through the binding's log().

import { laneMessage, parseMessage } from "./contract";
import { mergeLane } from "./merge-lane";
import { Store, type Remote } from "./git/store";

type Step = { step: string; ms: number; detail?: unknown };

/** Commit `files` on top of the remote's main (or as the first commit) and push. */
async function commitFiles(remote: Remote, files: Record<string, string>, message: string, agent = "g0-setup"): Promise<string> {
  const store = await Store.open();
  const tip = await store.fetch(remote, "main", 1).catch(() => null);
  const edits = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) edits.set(path, await store.writeText(text));
  const tree = await store.editTree(tip ? (await store.readCommit(tip)).tree : null, edits);
  const oid = await store.commit({ tree, parents: tip ? [tip] : [], message, author: { name: agent, email: `${agent}@braid.invalid` } });
  await store.push(remote, oid, "main");
  return oid;
}

export async function runG0(artifacts: Artifacts, keep = false) {
  const steps: Step[] = [];
  const t = async <T>(step: string, f: () => Promise<T>, detail?: (r: T) => unknown): Promise<T> => {
    const t0 = Date.now();
    const r = await f();
    steps.push({ step, ms: Date.now() - t0, detail: detail?.(r) });
    return r;
  };
  const id = crypto.randomUUID().slice(0, 8);
  const name = `g0-${id}`;
  const laneName = `${name}--fact-checker`;
  const remote = (r: { remote: string; token: string }): Remote => ({ url: r.remote, token: r.token });

  try {
    const created = await t("create canonical", () => artifacts.create(name, { setDefaultBranch: "main" }));
    const canonical = remote(created);
    await t("seed", () => commitFiles(canonical, {
      "towns/harbourne.md": "# Harbourne\n\nA made-up river town.\n",
      "people/ada-quill.md": "# Ada Quill\n\nPhone: 555 0100\n",
    }, "seed"));

    const forked = await t("fork", async () => {
      using repo = await artifacts.get(name);
      return repo.fork(laneName, { defaultBranchOnly: true });
    }, (r) => ({ name: r.name }));
    const forkReadyMs = await t("wait for fork ready", async () => {
      const t0 = Date.now();
      for (;;) {
        try {
          using repo = await artifacts.get(laneName);
          const info = await repo.info();
          if (info) return Date.now() - t0;
        } catch (e) {
          if (!/FORK_IN_PROGRESS|not ready|NOT_FOUND/i.test(String(e)) || Date.now() - t0 > 60_000) throw e;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    const lane = remote(forked);
    const forkPoint = await t("read fork point", async () => {
      using repo = await artifacts.get(laneName);
      return (await repo.log({ ref: "main", limit: 1 }))[0]?.hash;
    });

    await t("advance main 1", () => commitFiles(canonical, { "towns/harbourne.md": "# Harbourne\n\nA made-up town by a river.\n" }, "main advance 1"));
    const mainBefore = await t("advance main 2", () => commitFiles(canonical, { "places/mill.md": "# The Mill\n" }, "main advance 2"));

    const laneCommit = await t("commit on fork", async () => {
      const store = await Store.open();
      const tip = (await store.fetch(lane, "main", 1))!;
      const base = await store.blobAt(tip, "people/ada-quill.md");
      const content = "# Ada Quill\n\nPhone: 555 0199\n";
      const tree = await store.editTree((await store.readCommit(tip)).tree, new Map([["people/ada-quill.md", await store.writeText(content)]]));
      const msg = laneMessage({ agent: "fact-checker", reason: "Fix Ada's phone", source: "town directory, page 3", changes: [{ path: "people/ada-quill.md", base, content }] });
      const oid = await store.commit({ tree, parents: [tip], message: msg, author: { name: "fact-checker", email: "fact-checker@braid.invalid" } });
      await store.push(lane, oid, "main");
      return oid;
    });

    const merged = await t("mergeLane", () => mergeLane(canonical, lane, { since: forkPoint! }), (r) => ({ outcomes: r.outcomes, storeBytes: r.storeBytes }));

    const log = await t("log({ref:'main'})", async () => {
      using repo = await artifacts.get(name);
      return repo.log({ ref: "main", limit: 5 });
    });
    const head = log[0];
    const trailers = head ? parseMessage(head.message) : null;
    const pass =
      merged.outcomes.length === 1 && merged.outcomes[0].status === "merged" &&
      head?.hash === merged.mainAfter &&
      JSON.stringify(head.parents) === JSON.stringify([mainBefore, laneCommit]) &&
      trailers?.errors.length === 0 && trailers.trailers.laneCommit === laneCommit &&
      trailers.trailers.agent === "fact-checker" && trailers.trailers.resolution === "clean";
    const ada = await t("readFile on main", async () => {
      using repo = await artifacts.get(name);
      const f = await repo.readFile({ ref: "main", path: "people/ada-quill.md" });
      return f ? await f.text() : null;
    });
    return { pass: pass && !!ada?.includes("555 0199"), name, laneName, forkReadyMs, head, parentsExpected: [mainBefore, laneCommit], trailers, ada, steps };
  } catch (e) {
    console.error(JSON.stringify({ event: "g0_error", error: String(e), stack: (e as Error).stack }));
    return { pass: false, name, error: String(e), steps };
  } finally {
    if (!keep) {
      for (const n of [laneName, name]) await artifacts.delete(n).catch(() => false);
    }
  }
}
