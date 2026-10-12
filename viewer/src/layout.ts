// The river's geometry: main down the middle on a real time scale, one channel per agent.
// Pure (time and viewport height come in), so a test can lay out a story at any instant.

import type { State } from "./api";
import { colourOf, ago } from "./util";

export type Layout = ReturnType<typeof layout>;

export function layout(state: State, width: number, now: number, viewH: number) {
  const commits = [...state.main].reverse(); // oldest first: the river runs down the page
  const merges = commits.filter((c) => c.laneCommit && c.agent);
  const agents = [...new Set([...merges.map((c) => c.agent!), ...state.lanes.filter((l) => l.held).map((l) => l.agent)])];
  // On a phone the names do not fit over the channels: a legend above the river names them instead.
  const narrow = width < 600;
  const top = narrow ? 40 : 56, minGap = 14;
  // A lane bends out of main over its first 24 px and each merge curves back from 20 px above its
  // dot, so the clock's zero sits that far below the top: a merge in the first second still has a
  // straight lane to leave from, however far the window has zoomed out (#10).
  const zero = top + 44;
  const last = commits.at(-1)?.at ?? now;
  const live = now - last < 120;
  const t0 = commits[0]?.at ?? last;
  // While live the axis is a fixed height over a window from the first change, so a merge drops into
  // place and stays there and only the "now" line moves (rescaling on every poll made the river jump on
  // camera). The window starts at two minutes and doubles only when the story outgrows it. Once quiet,
  // the axis ends at the last change, so a finished story fills the page.
  const elapsed = Math.max(now, last) - t0;
  let windowS = 120;
  while (windowS < elapsed + 10) windowS *= 2;
  const t1 = live ? t0 + windowS : last;
  const span = Math.max(t1 - t0, 1);
  // Live, the river fits the window, so "now" stays on screen; finished, it sizes to the story.
  const scaleH = live ? Math.max(300, Math.min(600, viewH - zero - 150)) : Math.max(360, Math.min(900, merges.length * 22));

  // Real time, pushed apart only where commits land in the same instant.
  let lastY = -Infinity;
  const yOf = new Map<string, number>();
  for (const c of commits) {
    const y = Math.max(zero + ((c.at - t0) / span) * scaleH, lastY + minGap);
    yOf.set(c.hash, y);
    lastY = y;
  }
  const bottom = Math.max(lastY, zero + scaleH) + 40;
  // Where "now" is on the river while live; a held lane waits there, at its gravel bar.
  const nowAt = live ? Math.round(zero + ((now - t0) / span) * scaleH) : null;

  // On a phone the clock labels get their own strip on the right, so no lane runs under them.
  const gutter = narrow ? 64 : 0;
  const mainX = Math.round((width - gutter) / 2);
  const half = Math.ceil(agents.length / 2);
  const gap = Math.min(120, (mainX - (narrow ? 28 : 36)) / Math.max(half, 1));
  const lanes = agents.map((agent, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const x = Math.round(mainX + side * gap * (Math.floor(i / 2) + 1));
    const mine = merges.filter((m) => m.agent === agent);
    const held = state.lanes.find((l) => l.agent === agent)?.held;
    const end = held ? (nowAt ?? bottom - 20) : (yOf.get(mine.at(-1)?.hash ?? "") ?? top + 40) - 18;
    const channel = `M ${mainX} ${top - 20} C ${mainX} ${top + 10}, ${x} ${top - 10}, ${x} ${top + 24} L ${x} ${Math.max(end, top + 24)}`;
    return { agent, x, colour: colourOf(agent), short: agent, channel };
  });
  const xOf = new Map(lanes.map((l) => [l.agent, l.x]));
  const mergeMarks = merges.map((c) => {
    const y = yOf.get(c.hash)!;
    const x = xOf.get(c.agent!)!;
    return {
      hash: c.hash, y, x, agent: c.agent!, subject: c.subject, approvedBy: c.approvedBy, path: c.paths[0],
      colour: colourOf(c.agent!), marked: !!c.approvedBy || !!c.reverts,
      curve: `M ${x} ${y - 20} C ${x} ${y - 4}, ${mainX} ${y - 12}, ${mainX} ${y}`,
    };
  });
  const bars = state.lanes.filter((l) => l.held).map((l) => ({
    agent: l.agent, x: xOf.get(l.agent) ?? mainX, y: nowAt ?? bottom - 20,
    approval: state.approvals.find((a) => a.agent === l.agent)?.id ?? 0,
  })).filter((b) => b.approval);

  const ticks: { y: number; label: string }[] = [];
  for (let k = 0; k <= 3; k++) {
    const t = t0 + (span * k) / 3;
    // A short story reads better on the clock than as "23m ago" twice.
    const clock = new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: span < 600 ? "2-digit" : undefined });
    ticks.push({ y: Math.round(zero + (k / 3) * scaleH), label: span < 3600 ? clock : ago(t) });
  }
  return { top, bottom, height: bottom + 8, mainX, lanes, merges: mergeMarks, bars, ticks, nowY: nowAt, narrow } as const;
}
