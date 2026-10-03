// Real repos on a local smart-HTTP git server; no mocks.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
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
  it("a change the trailers do not declare makes the commit invalid", async () => {
    const sn = lane("sneaky");
    const before = main();
    const base = sn.blob("places/mill.md");
    sn.write("Declares one path, changes two", [{ path: "places/mill.md", base, content: "# The Mill\n\nsneaky\n" }, { path: "notes/hidden.md", base: null, content: "hidden\n" }],
      laneMessage({ agent: "sneaky", reason: "Declares one path", changes: [{ path: "places/mill.md", base, content: "x" }] }));
    const r = await mergeLane(url("memory"), url("memory--sneaky"), { since: sn.forkPoint });
    expect(r.outcomes).toMatchObject([{ status: "invalid", errors: ["changed but not declared: notes/hidden.md"] }]);
    expect(main()).toBe(before);
  });

  it("a declared path the writer left as read keeps main's version", async () => {
    const lz = lane("lazy");
    const base = lz.blob("people/ada-quill.md");
    c.write("people/ada-quill.md", "# Ada Quill\n\nPhone: 555 0177\n");
    c.commit("main moves Ada");
    lz.write("Touches Ada without changing her", [{ path: "people/ada-quill.md", base, content: raw(lz.dir, "show", "HEAD:people/ada-quill.md") }, { path: "notes/lazy.md", base: null, content: "x\n" }]);
    const r = await mergeLane(url("memory"), url("memory--lazy"), { since: lz.forkPoint });
    expect(r.outcomes[0].status, JSON.stringify(r.outcomes)).toBe("merged");
    expect(show("people/ada-quill.md")).toContain("555 0177");
  });

  it("main moving between fetch and push: the push is refused, main re-read, the merge redone", async () => {
    const rc = lane("racer");
    const theirs = raw(w.bare("memory"), "show", `${seed}:towns/harbourne.md`) + "## Events\n\nA fair in spring.\n";
    rc.write("Harbourne: add events", [{ path: "towns/harbourne.md", base: seedHarbourne, content: theirs }]);
    let moved = "";
    const readBase = async (oid: string) => {
      if (!moved) {
        c.write("places/bakery.md", "# Bakery\n");
        moved = c.commit("main moves mid-merge");
      }
      return execFileSync("git", ["cat-file", "blob", oid], { cwd: w.bare("memory"), encoding: "utf8" });
    };
    const r = await mergeLane(url("memory"), url("memory--racer"), { since: rc.forkPoint, readBase });
    expect(r.outcomes[0].status).toBe("merged");
    expect(sh(w.bare("memory"), "rev-parse", "main~1")).toBe(moved); // merged on top of the commit that raced it
    expect(show("places/bakery.md")).toContain("Bakery");
    expect(show("towns/harbourne.md")).toContain("A fair in spring.");
    expect(show("towns/harbourne.md")).toContain("555 0142");
    fsck();
  });
  it("undo: clean when main is untouched, undo of undo restores, undo after an overlapping edit conflicts", async () => {
    const un = lane("undoer");
    const P = "places/mill.md";
    const blobAt = (ref: string) => { try { return sh(w.bare("memory"), "rev-parse", `${ref}:${P}`); } catch { return null; } };
    const textAt = (ref: string) => raw(w.bare("memory"), "show", `${ref}:${P}`);
    // An undo envelope as revertEnvelope builds it: content before `target`, base = what `target` produced.
    const undo = (target: string) => ({ path: P, base: blobAt(target), content: textAt(`${target}^1`) });
    let since = un.forkPoint;
    const fold = async () => {
      const r = await mergeLane(url("memory"), url("memory--undoer"), { since });
      since = r.outcomes.at(-1)?.laneCommit ?? since;
      return r;
    };

    expect(sh(w.bare("memory"), "log", "-1", "--format=%s", "main", "--", P)).toBe("Mill: add owner");
    const lastMill = sh(w.bare("memory"), "log", "-1", "--format=%H", "main", "--", P);
    const before = textAt(`${lastMill}^1`), after = textAt(lastMill);
    un.write("Undo: Mill: add owner", [undo(lastMill)], laneMessage({ agent: "undoer", reason: "Undo: Mill: add owner", changes: [undo(lastMill)], reverts: lastMill }));
    const r1 = await fold();
    expect(r1.outcomes[0].status).toBe("merged");
    expect(show(P)).toBe(before);
    expect(parseMessage(sh(w.bare("memory"), "log", "-1", "--format=%B", "main")).trailers.reverts).toBe(lastMill);

    const u1 = main();
    un.write("Undo: Undo", [undo(u1)], laneMessage({ agent: "undoer", reason: "Undo: Undo", changes: [undo(u1)], reverts: u1 }));
    expect((await fold()).outcomes[0].status).toBe("merged");
    expect(show(P)).toBe(after);

    // A later edit to the same line, then an undo of the commit before it: a person decides.
    const u2 = main();
    c.write(P, after.replace("Pell family", "Pell and Daughters"));
    c.commit("Mill: new owner name");
    un.write("Undo: Undo: Undo", [undo(u2)], laneMessage({ agent: "undoer", reason: "Undo again", changes: [undo(u2)], reverts: u2 }));
    const r3 = await fold();
    expect(r3.outcomes[0]).toMatchObject({ status: "conflict" });
    expect(show(P)).toContain("Pell and Daughters");
  });
});
