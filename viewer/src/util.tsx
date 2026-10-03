import { useEffect, useState, type JSX } from "react";
import { diffLines, diffWords } from "diff";

// One channel colour per agent, from a survey-chart palette; stable across reloads.
const CHANNELS = ["#2e7d8c", "#5b7f3a", "#8a5a9e", "#b5651d", "#3d6fb0", "#9a4f63", "#4f6b5e", "#7a6a2b"];
// The demo's agents get fixed, well-separated channels; anyone else hashes into the palette.
const FIXED: Record<string, string> = {
  scout: "#4f6b5e", "fact-checker": "#3d6fb0", editor: "#9a4f63", translator: "#8a5a9e", archivist: "#7a6a2b", person: "#c2410c",
};
export function colourOf(agent: string): string {
  if (FIXED[agent]) return FIXED[agent];
  let h = 0;
  for (const ch of agent) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CHANNELS[h % CHANNELS.length];
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const on = () => setLoc(location.pathname + location.search);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return loc;
}

export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Word diff as React children: insertions and deletions marked, the rest plain. */
export function Diff({ from, to }: { from: string; to: string }) {
  return (
    <>
      {diffWords(from, to).map((p, i) =>
        p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>,
      )}
    </>
  );
}

/** The title of a markdown record: its first "# " line, else its file name. */
export function titleOf(text: string | null, path: string): string {
  const m = /^# (.+)$/m.exec(text ?? "");
  return m ? m[1] : path.split("/").pop() ?? path;
}

/** Only the lines that changed, each with its words marked: what a history entry needs to show. */
export function Changed({ from, to }: { from: string; to: string }) {
  const parts = diffLines(from, to);
  const rows: JSX.Element[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) continue;
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      rows.push(<div key={i}><Diff from={p.value.trimEnd()} to={next.value.trimEnd()} /></div>);
      i++;
    } else if (p.added) {
      rows.push(<div key={i}><ins>{p.value.trimEnd()}</ins></div>);
    } else {
      rows.push(<div key={i}><del>{p.value.trimEnd()}</del></div>);
    }
  }
  return <>{rows}</>;
}

/** A markdown record as a document: frontmatter and the title line left out, ## as headings. */
export function Doc({ text }: { text: string }) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^# .*\n/m, "");
  return (
    <>
      {body.split(/\n{2,}/).map((block, i) => {
        const t = block.trim();
        if (!t) return null;
        if (t.startsWith("## ")) return <h2 key={i}>{t.slice(3)}</h2>;
        return <p key={i}>{t}</p>;
      })}
    </>
  );
}

/** The new text, clean, with only what changed since `from` highlighted (no struck-out words). */
export function Marked({ from, to }: { from: string; to: string }) {
  return <>{diffWords(from, to).filter((p) => !p.removed).map((p, i) => (p.added ? <mark key={i}>{p.value}</mark> : <span key={i}>{p.value}</span>))}</>;
}
