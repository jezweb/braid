// Live: the memory as a braided river. Main runs down the middle on a real time
// scale; each agent's lane is a channel that braids back into main at every merge.
// A lane held by a conflict ends at a gravel bar that waits on a person.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type State } from "./api";
import { colourOf, navigate, ago } from "./util";

export function Live() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Poll only while someone is looking: every read is a metered operation.
    const tick = () => document.visibilityState === "visible" && api.state().then((s) => alive && (setState(s), setError(null))).catch((e) => alive && setError(String(e)));
    tick();
    const t = setInterval(tick, 4000);
    document.addEventListener("visibilitychange", tick);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, []);

  if (!state) return <div className="page"><p className="note">{error ?? "Loading"}</p></div>;
  if (state.missing) return <div className="page"><header className="top"><h1>{state.repo}</h1></header><p className="note">Not here yet. It appears when a run starts writing.</p></div>;
  const merges = state.main.filter((c) => c.laneCommit);
  const agents = new Set(merges.map((c) => c.agent).filter(Boolean));
  const waiting = state.approvals[0];
  return (
    <div className="page">
      <header className="top">
        <h1>{state.repo}</h1>
        <span className="line">{agents.size} agents · {merges.length} changes</span>
      </header>
      {waiting && state.repo === state.actOn && (
        <div className="waiting" role="status">
          <strong>{waiting.agent} waits on you</strong>
          <a className="go" href={`/approve/${waiting.id}`} onClick={(e) => { e.preventDefault(); navigate(`/approve/${waiting.id}`); }}>Review</a>
        </div>
      )}
      <Braid state={state} />
      <Records />
    </div>
  );
}

function Braid({ state }: { state: State }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => layout(state, width), [state, width]);
  return (
    <div ref={box}>
      {g.narrow && (
        <ul className="legend" aria-label="Agents">
          {[...g.lanes].sort((a, b) => a.x - b.x).map((l) => <li key={l.agent}><i style={{ background: l.colour }} />{l.agent}</li>)}
        </ul>
      )}
      <svg className="braid" viewBox={`0 0 ${width} ${g.height}`} height={g.height} role="img" aria-label={`Main and ${g.lanes.length} agent lanes over time`}>
        <defs>
          <pattern id="gravel" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="var(--bar-wash)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--bar)" strokeWidth="3" />
          </pattern>
        </defs>
        {g.ticks.map((t) => (
          <g key={t.y}>
            <line x1={0} x2={width} y1={t.y} y2={t.y} stroke="var(--rule)" strokeDasharray="2 6" />
            {/* A clock label steps aside when "now" sits on it. */}
            {(g.nowY === null || Math.abs(t.y + 14 - (g.nowY - 4)) > 16) && <text className="tick" x={width - 4} y={t.y + 14} textAnchor="end">{t.label}</text>}
          </g>
        ))}
        {g.nowY !== null && (
          <g>
            <line x1={0} x2={width} y1={g.nowY} y2={g.nowY} stroke="var(--bar)" strokeWidth={1} strokeDasharray="4 4" />
            <text className="tick" x={width - 4} y={g.nowY - 4} textAnchor="end" style={{ fill: "var(--bar)" }}>now</text>
          </g>
        )}
        {/* lanes: a channel leaving main at the top, running down beside it */}
        {g.lanes.map((l, i) => (
          <g key={l.agent}>
            <path className="flow" d={l.channel} fill="none" stroke={l.colour} strokeWidth={4} strokeLinecap="round" opacity={0.55}
              style={{ ["--len" as string]: 2000, ["--delay" as string]: `${i * 60}ms` }} />
            {!g.narrow && <text className="lane-label" x={l.x} y={g.top - 10} textAnchor="middle" fill={l.colour} style={{ fill: l.colour }}>{l.short}</text>}
          </g>
        ))}
        {/* main */}
        <line x1={g.mainX} x2={g.mainX} y1={g.top - 24} y2={g.bottom} stroke="var(--main)" strokeWidth={10} strokeLinecap="round" />
        <text className="lane-label" x={g.mainX} y={g.top - 30} textAnchor="middle" style={{ fill: "var(--main)" }}>main</text>
        {/* each merge braids its lane back into main */}
        {g.merges.map((m, i) => (
          <g key={m.hash} className="hit" onClick={() => m.path && navigate(`/record?path=${encodeURIComponent(m.path)}`)}>
            <title>{`${m.agent}: ${m.subject}${m.approvedBy ? ` (approved by ${m.approvedBy})` : ""}`}</title>
            <path className="flow" d={m.curve} fill="none" stroke={m.colour} strokeWidth={3} strokeLinecap="round"
              style={{ ["--len" as string]: 600, ["--delay" as string]: `${300 + i * 35}ms` }} />
            <circle className="dot appear" cx={g.mainX} cy={m.y} r={5} fill={m.marked ? "var(--bar)" : m.colour}
              stroke="var(--paper)" strokeWidth={2} style={{ ["--delay" as string]: `${300 + i * 35}ms` }} />
            <rect x={Math.min(m.x, g.mainX) - 6} y={m.y - 22} width={Math.abs(m.x - g.mainX) + 12} height={28} fill="transparent" />
          </g>
        ))}
        {/* held lanes end at a gravel bar */}
        {g.bars.map((b) => (
          <a key={b.agent} href={`/approve/${b.approval}`} onClick={(e) => { e.preventDefault(); navigate(`/approve/${b.approval}`); }}>
            <rect x={b.x - 26} y={b.y - 10} width={52} height={22} rx={11} fill="url(#gravel)" stroke="var(--bar)" strokeWidth={1.5} />
            <title>{`${b.agent} waits on a person`}</title>
          </a>
        ))}
      </svg>
    </div>
  );
}

type Layout = ReturnType<typeof layout>;

function layout(state: State, width: number) {
  const commits = [...state.main].reverse(); // oldest first: the river runs down the page
  const merges = commits.filter((c) => c.laneCommit && c.agent);
  const agents = [...new Set([...merges.map((c) => c.agent!), ...state.lanes.filter((l) => l.held).map((l) => l.agent)])];
  // On a phone the names do not fit over the channels: a legend above the river names them instead.
  const narrow = width < 600;
  const top = narrow ? 40 : 56, minGap = 14;
  const last = commits.at(-1)?.at ?? Date.now() / 1000;
  const live = Date.now() / 1000 - last < 120;
  const t0 = commits[0]?.at ?? last;
  // While live the axis is a fixed height over a window from the first change, so a merge drops into
  // place and stays there and only the "now" line moves (rescaling on every poll made the river jump on
  // camera). The window starts at two minutes and doubles only when the story outgrows it. Once quiet,
  // the axis ends at the last change, so a finished story fills the page.
  const elapsed = Math.max(Date.now() / 1000, last) - t0;
  let windowS = 120;
  while (windowS < elapsed + 10) windowS *= 2;
  const t1 = live ? t0 + windowS : last;
  const span = Math.max(t1 - t0, 1);
  // Live, the river fits the window, so "now" stays on screen; finished, it sizes to the story.
  const scaleH = live ? Math.max(300, Math.min(600, window.innerHeight - top - 150)) : Math.max(360, Math.min(900, merges.length * 22));

  // Real time, pushed apart only where commits land in the same instant.
  let lastY = -Infinity;
  const yOf = new Map<string, number>();
  for (const c of commits) {
    const y = Math.max(top + ((c.at - t0) / span) * scaleH, lastY + minGap);
    yOf.set(c.hash, y);
    lastY = y;
  }
  const bottom = Math.max(lastY, top + scaleH) + 40;
  // Where "now" is on the river while live; a held lane waits there, at its gravel bar.
  const nowAt = live ? Math.round(top + ((Date.now() / 1000 - t0) / span) * scaleH) : null;

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
    ticks.push({ y: Math.round(top + (k / 3) * scaleH), label: span < 3600 ? clock : ago(t) });
  }
  return { top, bottom, height: bottom + 8, mainX, lanes, merges: mergeMarks, bars, ticks, nowY: nowAt, narrow } as const;
}

export type { Layout };

function Records() {
  const [paths, setPaths] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.records().then(setPaths).catch(() => setPaths([])); }, []);
  if (!paths.length) return null;
  const folders = new Map<string, string[]>();
  for (const p of paths) {
    const f = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    folders.set(f, [...(folders.get(f) ?? []), p]);
  }
  const go = (p: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(`/record?path=${encodeURIComponent(p)}`); };
  return (
    <section className="folders" aria-label="Records">
      {[...folders].map(([f, ps]) => (
        <div key={f} className="folder">
          {ps.length === 1 ? (
            <a href={`/record?path=${encodeURIComponent(ps[0])}`} onClick={go(ps[0])}>{ps[0]}</a>
          ) : (
            <>
              <button className="folder-name" aria-expanded={open === f} onClick={() => setOpen(open === f ? null : f)}>{f}/ <span>{ps.length}</span></button>
              {open === f && <ul>{ps.map((p) => <li key={p}><a href={`/record?path=${encodeURIComponent(p)}`} onClick={go(p)}>{p.slice(f.length + 1)}</a></li>)}</ul>}
            </>
          )}
        </div>
      ))}
    </section>
  );
}
