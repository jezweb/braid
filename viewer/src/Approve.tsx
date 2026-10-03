// Approve: one question, the proposal shown as a change to main, one primary action.

import { useEffect, useState } from "react";
import { api, type Approval, type Conflict } from "./api";
import { Diff, navigate } from "./util";

export function Approve({ id }: { id: number }) {
  const [a, setA] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => { api.approval(id).then(setA).catch((e) => setError(String(e))); }, [id]);

  const act = async (action: "approve" | "ours" | "theirs" | "edit", text?: string) => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.resolve(id, action, text);
      navigate(`/record?path=${encodeURIComponent(done.path)}&after=${id}`);
    } catch (e) {
      setError((e as Error).message === "sign in to act" ? "Sign in to decide." : (e as Error).message);
      setBusy(false);
    }
  };

  if (!a) return <div className="page"><Back /><p className="note">{error ?? "Loading"}</p></div>;
  if (a.status !== "open") {
    return (
      <div className="page"><Back />
        <h1 className="question">Already decided</h1>
        <p className="note">{a.approvedBy ? `${a.approvedBy} chose ${a.resolution === "llm" ? "the proposal" : "a side"}.` : "Main moved on; this question was replaced."}</p>
        <a className="back" href={`/record?path=${encodeURIComponent(a.path)}`} onClick={(e) => { e.preventDefault(); navigate(`/record?path=${encodeURIComponent(a.path)}`); }}>See the record</a>
      </div>
    );
  }

  const overlaps = a.conflicts.filter((c): c is Extract<Conflict, { kind: "overlap" }> => c.kind === "overlap");
  const others = a.conflicts.filter((c) => c.kind !== "overlap");
  const question = overlaps.length && !others.length
    ? overlaps.length === 1 ? "Two edits to the same lines" : `Two edits clash in ${overlaps.length} places`
    : others[0]?.kind === "delete" ? "Edited on one side, deleted on the other" : "Two edits disagree";
  const where = overlaps.length === 1 && overlaps[0].section !== "(top)" ? `, ${overlaps[0].section.replace(/^## /, "")}` : "";

  return (
    <div className="page">
      <Back />
      <h1 className="question">{question}</h1>
      <p className="where">{a.path}{where}</p>

      {editing !== null ? (
        <textarea className="edit" value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Your version of the record" />
      ) : (
        <>
          {/* Every conflict the decision resolves is on screen: a choice never settles something unseen. */}
          {overlaps.map((o, i) => {
            const proposed = a.proposal ? sectionOf(a.proposal, o.section) : null;
            return (
              <section key={i} className="clash">
                {overlaps.length > 1 && <h2>{o.section.replace(/^## /, "")}</h2>}
                {proposed !== null && <div className="proposal"><b>Proposal</b><Diff from={body(o.ours)} to={body(proposed)} /></div>}
                <div className="sides">
                  <div className="side"><b>Main now</b><Diff from={body(o.base)} to={body(o.ours)} /></div>
                  <div className="side"><b>{a.agent} wrote</b><Diff from={body(o.base)} to={body(o.theirs)} /></div>
                </div>
              </section>
            );
          })}
          {others.map((c, i) => (
            <section key={`o${i}`} className="clash">
              <div className="sides">
                {c.kind === "field" ? (
                  <>
                    <div className="side"><b>Main: {c.key}</b>{c.ours}</div>
                    <div className="side"><b>{a.agent}: {c.key}</b>{c.theirs}</div>
                  </>
                ) : (
                  <>
                    <div className="side"><b>Main now</b>{a.oursText ?? "(deleted)"}</div>
                    <div className="side"><b>{a.agent} wrote</b>{a.theirsText ?? "(deleted)"}</div>
                  </>
                )}
              </div>
            </section>
          ))}
        </>
      )}
      {error && <p className="note error" role="alert">{error}</p>}

      <div className="bar"><div className="inner">
        {editing !== null ? (
          <>
            <button className="primary" disabled={busy} onClick={() => act("edit", editing)}>Save</button>
            <button className="quiet" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </>
        ) : (
          <>
            {a.proposal && <button className="primary wide" disabled={busy} onClick={() => act("approve")}>Approve</button>}
            <div className="others">
              <button className="link" disabled={busy} onClick={() => act("ours")}>Keep main</button>
              <button className="link" disabled={busy} onClick={() => act("theirs")}>Take {a.agent}'s</button>
              <button className="link" disabled={busy} onClick={() => setEditing(a.proposal ?? a.oursText ?? "")}>Edit</button>
            </div>
          </>
        )}
      </div></div>
    </div>
  );
}

/** A section without its heading line (the heading is already in the line above) and outer blank lines. */
function body(section: string): string {
  return section.replace(/^## [^\n]*\n/, "").trim();
}

function sectionOf(record: string, heading: string): string | null {
  if (heading === "(top)" || heading === "(body)") return record;
  const start = record.indexOf(heading + "\n");
  if (start < 0) return null;
  const next = record.indexOf("\n## ", start + heading.length);
  return record.slice(start, next < 0 ? undefined : next + 1);
}

function Back() {
  return <a className="back" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>← Live</a>;
}
