import { describe, expect, it } from "vitest";
import { layout } from "../src/layout";
import type { State } from "../src/api";

// harbourne's real timings (13 Oct take): the editor merges twice in the same second,
// 24 s in, and the live window doubles from 4 to 8 minutes near the end of the run.
const T0 = 1_760_000_000;
const story: [number, string | null, string][] = [
  [0, null, "Harbourne: first records"],
  [24, "editor", "Tighten the summary"],
  [24, "editor", "Date the bridge"],
  [24, "fact-checker", "Fix Ada Quill's phone"],
  [25, "scout", "Add the Saturday market"],
  [79, "translator", "Summary in plain English"],
  [105, "archivist", "Tidy the town record"],
  [147, "person", "Undo: Tidy the town record"],
  [194, "person", "Undo: Undo: Tidy the town record"],
  [221, "claude-code", "Add the ferry"],
];

function state(): State {
  const main = story.map(([at, agent, subject], i) => ({
    hash: `c${i}`, at: T0 + at, agent: agent ?? undefined, subject, laneCommit: agent ? `l${i}` : undefined, paths: ["town.md"],
  }));
  return { repo: "harbourne", actOn: "harbourne", main: main.reverse(), lanes: [], approvals: [] } as unknown as State;
}

const lastY = (channel: string) => Number(channel.trim().split(/\s+/).at(-1));

describe("live river layout", () => {
  // Window 240 s just before the doubling, 480 s just after it; desktop and phone.
  for (const [width, viewH] of [[1280, 800], [390, 844], [960, 600]]) {
    for (const now of [T0 + 225, T0 + 235]) {
      it(`every lane leaves main before its merges return (${width}x${viewH}, ${now - T0} s)`, () => {
        const g = layout(state(), width, now, viewH);
        const straight = g.top + 24; // where a lane has finished bending out of main
        for (const lane of g.lanes) {
          const mine = g.merges.filter((m) => m.agent === lane.agent);
          expect(mine.length).toBeGreaterThan(0);
          // Each return curve starts on the straight part of its lane, never above the bend.
          for (const m of mine) expect(m.y - 20).toBeGreaterThanOrEqual(straight);
          // The lane runs down to its last merge's curve, not clamped short of it.
          expect(lastY(lane.channel)).toBe(Math.max(...mine.map((m) => m.y)) - 18);
        }
      });
    }
  }
});
