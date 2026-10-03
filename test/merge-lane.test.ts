// Real repos on a local smart-HTTP git server; no mocks.
import { describe, it, expect, afterAll } from "vitest";
import { gitWorld, raw, sh } from "./helpers";
import { mergeLane } from "../src/merge-lane";
import { laneMessage, parseMessage, type Change } from "../src/contract";

describe("mergeLane: folding lane commits into main", async () => {
  const w = await gitWorld();
  afterAll(() => w.close());
  const main = () => sh(w.bare("memory"), "rev-parse", "main");
  const show = (path: string) => raw(w.bare("memory"), "show", `main:${path}`);
  const fsck = () => sh(w.bare("memory"), "fsck", "--strict", "--no-dangling");
  const url = (n: string) => ({ url: w.url(n) });

  w.createRepo("memory");
  const c = w.work("memory");
  c.write("towns/harbourne.md", "---\ntitle: Harbourne\nstatus: draft\n---\n# Harbourne\n\n## Summary\n\nA made-up river town.\n\n## Contacts\n\nTown hall: 555 0100\n");
  c.write("people/ada-quill.md", "# Ada Quill\n\nPhone: 555 0100\n");
  const seed = c.commit("seed");
  const seedHarbourne = c.blob("towns/harbourne.md");

  /** Fork `memory` as it is now into memory--<agent>, returning a writer for that lane. */
  const lane = (agent: string) => {
    w.fork("memory", `memory--${agent}`);
    const forkPoint = main();
    const l = w.work(`memory--${agent}`);
    const write = (reason: string, changes: (Change & { text?: string })[], message?: string) => {
      for (const ch of changes) {
        if (ch.content === null) sh(l.dir, "rm", "-q", ch.path);
        else l.write(ch.path, ch.content);
      }
      sh(l.dir, "add", "-A");
      sh(l.dir, "commit", "-q", "--allow-empty", "-m", message ?? laneMessage({ agent, reason, changes }));
      sh(l.dir, "push", "-q", "origin", "HEAD:main");
      return sh(l.dir, "rev-parse", "HEAD");
    };
    return { forkPoint, write, blob: l.blob, dir: l.dir };
  };

  it("G0: merges a lane commit as a two-parent commit carrying its trailers", async () => {
    const fc = lane("fact-checker");
    c.write("towns/harbourne.md", show("towns/harbourne.md").replace("A made-up river town.", "A made-up town by a river."));
    c.commit("main advance 1");
    c.write("places/mill.md", "# The Mill\n");
    c.commit("main advance 2");
    const before = main();
    const base = fc.blob("people/ada-quill.md");
    const lc = fc.write("Fix Ada's phone", [{ path: "people/ada-quill.md", base, content: "# Ada Quill\n\nPhone: 555 0199\n" }]);

    const r = await mergeLane(url("memory"), url("memory--fact-checker"), { since: fc.forkPoint });
    expect(r.outcomes).toEqual([{ status: "merged", laneCommit: lc, mergeCommit: r.mainAfter, resolution: "clean" }]);
    expect(main()).toBe(r.mainAfter);
    expect(sh(w.bare("memory"), "log", "-1", "--format=%P", "main").split(" ")).toEqual([before, lc]);
    const t = parseMessage(sh(w.bare("memory"), "log", "-1", "--format=%B", "main"));
    expect(t.errors).toEqual([]);
    expect(t.trailers).toMatchObject({ agent: "fact-checker", laneCommit: lc, resolution: "clean", recordPaths: [{ path: "people/ada-quill.md", base }] });
    expect(show("people/ada-quill.md")).toContain("555 0199");
    expect(show("places/mill.md")).toContain("The Mill");
    fsck();

    // Running again from the merged commit is a no-op: nothing is re-applied.
    const again = await mergeLane(url("memory"), url("memory--fact-checker"), { since: lc });
    expect(again.outcomes).toEqual([]);
    expect(main()).toBe(r.mainAfter);
  });

  it("stacked writes: two unmerged lane commits merge in order, the second edited from the first", async () => {
    const ed = lane("editor");
    const b0 = ed.blob("places/mill.md");
    const l1 = ed.write("Mill: add year", [{ path: "places/mill.md", base: b0, content: "# The Mill\n\nBuilt 1888.\n" }]);
    const b1 = ed.blob("places/mill.md");
    const l2 = ed.write("Mill: add owner", [{ path: "places/mill.md", base: b1, content: "# The Mill\n\nBuilt 1888. Run by the Pell family.\n" }]);
    const r = await mergeLane(url("memory"), url("memory--editor"), { since: ed.forkPoint });
    expect(r.outcomes.map((o) => [o.status, o.laneCommit])).toEqual([["merged", l1], ["merged", l2]]);
    expect(show("places/mill.md")).toContain("Pell family");
    expect(sh(w.bare("memory"), "log", "--first-parent", "-2", "--format=%s", "main")).toBe("Mill: add owner\nMill: add year");
    fsck();
  });

  it("same record, different sections, base only in old history: merges through the table", async () => {
    const tr = lane("translator");
    // translator edits Contacts from the SEED blob; main has since changed Summary.
    const theirs = raw(w.bare("memory"), "show", `${seed}:towns/harbourne.md`).replace("555 0100", "555 0142");
    tr.write("Harbourne: new town hall number", [{ path: "towns/harbourne.md", base: seedHarbourne, content: theirs }]);
    const r = await mergeLane(url("memory"), url("memory--translator"), { since: tr.forkPoint });
    expect(r.outcomes[0], JSON.stringify(r.outcomes)).toMatchObject({ status: "merged", resolution: "clean" });
    expect(show("towns/harbourne.md")).toContain("A made-up town by a river.");
    expect(show("towns/harbourne.md")).toContain("555 0142");
    fsck();
  });

  it("same section, overlapping lines: conflict, main untouched", async () => {
    const sc = lane("scout");
    const before = main();
    const theirs = raw(w.bare("memory"), "show", `${seed}:towns/harbourne.md`).replace("A made-up river town.", "A made-up town on a hill.");
    const lc = sc.write("Hill, not river", [{ path: "towns/harbourne.md", base: seedHarbourne, content: theirs }]);
    const r = await mergeLane(url("memory"), url("memory--scout"), { since: sc.forkPoint });
    expect(r.outcomes).toMatchObject([{ status: "conflict", laneCommit: lc, conflicts: [{ path: "towns/harbourne.md", conflicts: [{ kind: "overlap", section: "## Summary" }] }] }]);
    expect(main()).toBe(before);
  });

  it("malformed trailers and file/folder collisions are refused, main untouched", async () => {
    const bad = lane("bad-writer");
    const before = main();
    const lc = bad.write("x", [{ path: "notes/a.md", base: null, content: "a\n" }], "Bad trailers\n\nAgent: bad-writer\nRecord-Path: notes/a.md not-a-sha\n");
    const r = await mergeLane(url("memory"), url("memory--bad-writer"), { since: bad.forkPoint });
    expect(r.outcomes).toMatchObject([{ status: "invalid", laneCommit: lc }]);
    expect(main()).toBe(before);

    const col = lane("collider");
    col.write("Folder over a file", [{ path: "places/mill.md/extra.md", base: null, content: "x\n" }].map((ch) => ({ ...ch, path: "places/mill-x.md" })),
      laneMessage({ agent: "collider", reason: "Folder over a file", changes: [{ path: "places/mill.md/extra.md", base: null, content: "x" }] }));
    const r2 = await mergeLane(url("memory"), url("memory--collider"), { since: col.forkPoint });
    expect(r2.outcomes[0].status).toBe("invalid");
    expect(main()).toBe(before);
  });
});
