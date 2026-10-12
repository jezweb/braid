// Live: the memory as a braided river. Main runs down the middle on a real time
// scale; each agent's lane is a channel that braids back into main at every merge.
// A lane held by a conflict ends at a gravel bar that waits on a person.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type State } from "./api";
import { navigate } from "./util";
import { layout } from "./layout";

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

  const g = useMemo(() => layout(state, width, Date.now() / 1000, window.innerHeight), [state, width]);
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
