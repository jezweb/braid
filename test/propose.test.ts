import { describe, expect, it } from "vitest";
import { proposeSection } from "../src/propose";

const c = {
  kind: "overlap" as const,
  section: "Summary",
  base: "## Summary\nHarbourne is a made-up river town of about 4,000 people.\n\n",
  ours: "## Summary\nHarbourne is a fictional river town of roughly 4,000 residents.\n\n",
  theirs: "## Summary\nHarbourne is a fictional river town. About 4,000 people live there.\n\n",
};
// A stand-in for Workers AI that answers each call with the next reply.
const ai = (...replies: string[]) => ({ run: async () => ({ response: replies.shift() ?? "" }) }) as unknown as Ai;

describe("merge proposals", () => {
  it("keeps one side repeated when it already carries the other's edit", async () => {
    const sup = { kind: "overlap" as const, section: "Hours", base: "## Hours\nThe mill opens at 8.\n\n",
      ours: "## Hours\nThe mill opens at 9.\n\n", theirs: "## Hours\nThe mill opens at 9. Admission is free.\n\n" };
    expect(await proposeSection(ai(sup.theirs.trim()), "m", sup)).toBe(sup.theirs.trim() + "\n\n");
  });

  it("keeps a proposal that merges both edits", async () => {
    const merged = "## Summary\nHarbourne is a fictional river town. Roughly 4,000 residents live there.";
    expect(await proposeSection(ai(merged), "m", c)).toBe(merged + "\n\n");
  });

  it("refuses one side repeated word for word, and asks again", async () => {
    const merged = "## Summary\nHarbourne is a fictional river town. Roughly 4,000 residents live there.";
    expect(await proposeSection(ai(c.ours.trim(), merged), "m", c)).toBe(merged + "\n\n");
    expect(await proposeSection(ai(c.ours.trim(), c.theirs.trim()), "m", c)).toBeUndefined();
  });
});
