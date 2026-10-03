import { describe, it, expect } from "vitest";
import { mergeRecord, splitRecord } from "../src/merge";

const rec = (fm: Record<string, string>, body: string) =>
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}\n`).join("")}---\n${body}`;

const BODY = `# Harbourne

A made-up river town.

## Summary

Harbourne sits where two creeks meet.
It has one bridge and a mill.

## Contacts

Town hall: 555 0100

## History

Founded by fictional settlers.
`;
const FM = { title: "Harbourne", status: "draft", last_edited_by: "scout", last_edited_at: '"2026-10-03T10:00:00+10:00"' };
const base = rec(FM, BODY);

describe("merge table", () => {
  it("round-trips a record exactly through split and join", () => {
    for (const s of [base, BODY, "", "no newline", "---\na: 1\n---\n", "## A\n## A\nx\n"]) {
      const r = mergeRecord({ base: "zzz", ours: s, theirs: s });
      expect(r).toEqual({ status: "clean", content: s, resolution: "clean" });
    }
    expect(splitRecord(base).sections.map((s) => s.key)).toEqual(["#0", "## Summary#0", "## Contacts#0", "## History#0"]);
  });

  it("main unchanged: takes the writer's content", () => {
    const theirs = base.replace("one bridge", "two bridges");
    expect(mergeRecord({ base, ours: base, theirs })).toEqual({ status: "clean", content: theirs, resolution: "clean" });
  });

  it("writer's content equals base or main: keeps main", () => {
    const ours = base.replace("draft", "live");
    expect(mergeRecord({ base, ours, theirs: base })).toMatchObject({ content: ours });
    expect(mergeRecord({ base, ours, theirs: ours })).toMatchObject({ content: ours });
  });

  it("same file, different frontmatter keys: field merge", () => {
    const ours = base.replace("status: draft", "status: live");
    const theirs = base.replace("title: Harbourne", "title: Harbourne-on-Creek");
    const r = mergeRecord({ base, ours, theirs });
    expect(r).toMatchObject({ status: "clean", resolution: "field" });
    expect(r.status === "clean" && r.content).toBe(base.replace("status: draft", "status: live").replace("title: Harbourne\n", "title: Harbourne-on-Creek\n"));
  });

  it("same key, different values: last_edited_* takes the latest, other keys conflict", () => {
    const ours = rec({ ...FM, last_edited_by: "editor", last_edited_at: '"2026-10-03T10:05:00+10:00"' }, BODY);
    const theirs = rec({ ...FM, last_edited_by: "translator", last_edited_at: '"2026-10-03T10:04:00+10:00"' }, BODY.replace("## History", "## Story"));
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status).toBe("clean");
    expect(r.status === "clean" && r.content).toContain("last_edited_by: editor");
    expect(r.status === "clean" && r.content).toContain("## Story");

    const r2 = mergeRecord({ base, ours: base.replace("status: draft", "status: live"), theirs: base.replace("status: draft", "status: archived") });
    expect(r2).toMatchObject({ status: "conflict", conflicts: [{ kind: "field", key: "status", ours: "live", theirs: "archived" }] });
  });

  it("same file, different sections: clean", () => {
    const ours = base.replace("555 0100", "555 0142");
    const theirs = base.replace("fictional settlers", "fictional millers");
    const r = mergeRecord({ base, ours, theirs });
    expect(r).toEqual({ status: "clean", resolution: "clean", content: base.replace("555 0100", "555 0142").replace("fictional settlers", "fictional millers") });
  });

  it("new sections from both sides keep their places", () => {
    const ours = base.replace("## History", "## Transport\n\nOne bus.\n\n## History");
    const theirs = base + "\n## Events\n\nA fair in spring.\n";
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status === "clean" && r.content).toBe(base.replace("## History", "## Transport\n\nOne bus.\n\n## History") + "\n## Events\n\nA fair in spring.\n");
  });

  it("same section, diff3 merges cleanly: clean", () => {
    const ours = base.replace("Harbourne sits where", "Harbourne lies where");
    const theirs = base.replace("Founded by", "First settled by").replace("and a mill.\n", "and a mill.\n\nIt floods most winters.\n");
    // theirs edits the end of Summary, ours its first line; a blank line apart is not needed for separate lines
    const t2 = base.replace("and a mill.\n", "and a mill.\n\nIt floods most winters.\n");
    const r = mergeRecord({ base, ours, theirs: t2 });
    expect(r).toMatchObject({ status: "clean" });
    expect(r.status === "clean" && r.content).toContain("Harbourne lies where");
    expect(r.status === "clean" && r.content).toContain("It floods most winters.");
    expect(mergeRecord({ base, ours, theirs }).status).toBe("clean");
  });

  it("same section, overlapping lines: overlap conflict carrying all three texts", () => {
    const ours = base.replace("It has one bridge and a mill.", "It has a stone bridge and a working mill.");
    const theirs = base.replace("It has one bridge and a mill.", "It keeps one bridge, a mill and a ferry.");
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ kind: "overlap", section: "## Summary" });
  });

  it("edit against delete: a person decides, both directions", () => {
    const ours = base.replace("draft", "live");
    expect(mergeRecord({ base, ours, theirs: null })).toMatchObject({ status: "conflict", conflicts: [{ kind: "delete" }] });
    expect(mergeRecord({ base, ours: null, theirs: ours })).toMatchObject({ status: "conflict", conflicts: [{ kind: "delete" }] });
  });

  it("delete against unchanged main: clean delete", () => {
    expect(mergeRecord({ base, ours: base, theirs: null })).toEqual({ status: "clean", content: null, resolution: "clean" });
  });

  it("section deleted on one side, edited on the other: conflict", () => {
    const ours = base.replace("## Contacts\n\nTown hall: 555 0100\n\n", "");
    const theirs = base.replace("555 0100", "555 0142");
    expect(mergeRecord({ base, ours, theirs })).toMatchObject({ status: "conflict", conflicts: [{ kind: "delete" }] });
  });

  it("both created the same path with different text: sections merge from an empty base", () => {
    const r = mergeRecord({ base: null, ours: "# A\n\n## One\nx\n", theirs: "# A\n\n## Two\ny\n" });
    expect(r).toMatchObject({ status: "clean", content: "# A\n\n## One\nx\n## Two\ny\n" });
  });
});

describe("merge table: review findings (codex, 3 Oct)", () => {
  const base = "---\ntitle: T\nlast_edited_by: alice\nlast_edited_at: \"2026-10-03T10:00:00+10:00\"\n---\n# T\n\n## A\n\na\n\n## B\n\nb\n";

  it("rebuilds an untouched record exactly when both sides changed something else", () => {
    const tricky = "---\n\na: 1\na: 2\n  cont\n---\n\n## X\nx\n## X\ny\n";
    const ours = tricky.replace("x\n", "x2\n");
    const theirs = tricky.replace("y\n", "y2\n");
    const r = mergeRecord({ base: tricky, ours, theirs });
    expect(r).toEqual({ status: "clean", resolution: "clean", content: tricky.replace("x\n", "x2\n").replace("y\n", "y2\n") });
  });

  it("keeps the writer's section reordering", () => {
    const ours = base.replace("\na\n", "\na2\n");
    const theirs = base.replace("## A\n\na\n\n## B\n\nb\n", "## B\n\nb\n\n## A\n\na\n\n");
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status === "clean" && r.content).toBe(base.replace("## A\n\na\n\n## B\n\nb\n", "## B\n\nb\n\n## A\n\na2\n\n"));
  });

  it("two different reorders conflict", () => {
    const three = base + "\n## C\n\nc\n";
    const ours = three.replace("## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n", "## C\n\nc\n## A\n\na\n\n## B\n\nb\n\n");
    const theirs = three.replace("## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n", "## B\n\nb\n\n## A\n\na\n\n## C\n\nc\n");
    expect(mergeRecord({ base: three, ours, theirs })).toMatchObject({ status: "conflict", conflicts: [{ kind: "order" }] });
  });

  it("last_edited_* move as a group from the later edit", () => {
    const ours = base.replace("10:00:00", "10:09:00").replace("\na\n", "\na2\n"); // alice, later
    const theirs = base.replace("alice", "bob").replace("10:00:00", "10:05:00").replace("\nb\n", "\nb2\n"); // bob, earlier
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status === "clean" && r.content).toContain("last_edited_by: alice\nlast_edited_at: \"2026-10-03T10:09:00+10:00\"");
  });

  it("removing the frontmatter on one side removes it", () => {
    const ours = base.replace("\na\n", "\na2\n");
    const theirs = base.replace(/^---[\s\S]*?---\n/, "");
    const r = mergeRecord({ base, ours, theirs });
    expect(r.status === "clean" && r.content).toBe(theirs.replace("\na\n", "\na2\n"));
  });
});

describe("merge table: panel findings (bt, 3 Oct)", () => {
  it("an unreadable last_edited_at gives no 'later': clashing keys conflict", () => {
    const base = "---\nlast_edited_by: a\nlast_edited_at: \"2026-10-03T10:00:00+10:00\"\n---\nx\n";
    const ours = base.replace("by: a", "by: b").replace("10:00:00", "10:05:00");
    const theirs = base.replace("by: a", "by: c").replace(/last_edited_at: .*\n/, "last_edited_at: soon\n");
    expect(mergeRecord({ base, ours, theirs })).toMatchObject({ status: "conflict" });
  });

  it("a new same-named heading merges the body as one text instead of shifting keys", () => {
    const base = "# T\n\n## Note\n\none\n\n## End\n\nz\n";
    const ours = base.replace("# T\n\n", "# T\n\n## Note\n\nzero\n\n");
    const theirs = base.replace("\nz\n", "\nzz\n");
    const r = mergeRecord({ base, ours, theirs });
    expect(r).toEqual({ status: "clean", resolution: "clean", content: "# T\n\n## Note\n\nzero\n\n## Note\n\none\n\n## End\n\nzz\n" });
  });

  it("keeps a blank line before the closing delimiter", () => {
    const base = "---\na: 1\n\n---\nbody\n";
    const r = mergeRecord({ base, ours: base.replace("a: 1", "a: 2"), theirs: base.replace("body", "body2") });
    expect(r.status === "clean" && r.content).toBe("---\na: 2\n\n---\nbody2\n");
  });
});

describe("merge table: resolver", () => {
  it("fills an overlapping section from the resolver and leaves the rest of the merge intact", () => {
    const base = "# T\n\n## A\n\nold a\n\n## B\n\nb\n";
    const ours = base.replace("old a", "ours a").replace("\nb\n", "\nb2\n");
    const theirs = base.replace("old a", "theirs a");
    const r = mergeRecord({ base, ours, theirs }, (c) => (c.section === "## A" ? "## A\n\nboth a\n\n" : undefined));
    expect(r).toEqual({ status: "clean", resolution: "clean", content: "# T\n\n## A\n\nboth a\n\n## B\n\nb2\n" });
    expect(mergeRecord({ base, ours, theirs }, () => undefined).status).toBe("conflict");
  });
});

describe("side choices touch only the overlapping section", async () => {
  const { sideRecord } = await import("../src/propose");
  it("takes the writer's section and keeps main's clean changes elsewhere", () => {
    const base = "# T\n\n## A\n\nold\n\n## B\n\n555 0100\n";
    const ours = base.replace("old", "main's").replace("555 0100", "555 0142");
    const theirs = base.replace("old", "writer's");
    expect(sideRecord(base, ours, theirs, "theirs")).toBe("# T\n\n## A\n\nwriter's\n\n## B\n\n555 0142\n");
    expect(sideRecord(base, ours, theirs, "ours")).toBe(ours);
  });
});

describe("side choices survive the whole-body fallback (codex G2 repro)", async () => {
  const { sideRecord } = await import("../src/propose");
  it("a repeated-heading insertion plus a conflict in ## A does not undo main's phone in ## B", () => {
    const base = "# T\n\n## A\n\nold\n\n## B\n\nPhone: 555 0100\n";
    const ours = base.replace("old", "main's").replace("555 0100", "555 0142");
    const theirs = base.replace("old", "writer's").replace("## B", "## A\n\nanother\n\n## B");
    const r = sideRecord(base, ours, theirs, "theirs")!;
    expect(r).toContain("555 0142");
    expect(r).toContain("writer's");
    expect(r).toContain("another");
  });
});
