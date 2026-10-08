// Record: what it says now, then every change that made it so, newest first, each with Undo.

import { useCallback, useEffect, useState } from "react";
import { api, signInHref, type Approval, type HistoryEntry } from "./api";
import { ago, Changed, colourOf, Doc, navigate, titleOf, useWatchingOther } from "./util";

type Entry = HistoryEntry & { before: string | null; after: string | null };

export function Record({ path, after }: { path: string; after?: number }) {
  const watching = useWatchingOther();
  const [now, setNow] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Approval | null>(null);

  const load = useCallback(async () => {
    const [rec, hist] = await Promise.all([api.record(path), api.history(path)]);
    // Diffs for the latest six changes; past versions never change, so the API caches them for good.
    const withDiffs = await Promise.all(hist.slice(0, 6).map(async (h) => {
      const r = await api.record(path, h.commit);
      return { ...h, before: r.before ?? null, after: r.after };
    }));
    setNow(rec.after);
    setEntries(withDiffs);
    if (after !== undefined) setDecision(await api.approval(after).catch(() => null));
    return hist[0]?.commit;
  }, [path, after]);

  useEffect(() => {
    let alive = true;
    load().catch((e) => alive && setError(String(e)));
    // Refresh only while visible; past versions are fetched once (they never change) and cached by the API.
    const t = setInterval(() => document.visibilityState === "visible" && load().catch(() => undefined), 10000);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  const undo = async (commit: string) => {
    setBusy(commit);
    setError(null);
    try {
      await api.undo(commit, path);
      // The undo is a write: it reaches main through the merge queue in a few seconds.
      const before = entries?.[0]?.commit;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if ((await load()) !== before) break;
      }
    } catch (e) {
      setError((e as Error).message === "sign in to act" ? "SIGNIN" : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <a className="back" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>← Live</a>
      <header className="top"><h1>{titleOf(now, path)}</h1><span className="line">{path}</span></header>
      {now === null && entries ? <p className="note">Deleted from main.</p> : <article className="doc"><Doc text={now ?? ""} /></article>}
      {decision && decision.status === "resolved" && <p className="landing" role="status">Your decision is merging</p>}
      {decision && decision.status === "superseded" && <p className="landing" role="status">Main changed first; this needs a fresh look</p>}
      {error === "SIGNIN" ? <p className="note" role="alert"><a href={signInHref()}>Sign in</a> to undo.</p> : error && <p className="note error" role="alert">{error}</p>}
      <ol className="timeline" aria-label="Changes, newest first">
        {(entries ?? []).map((e) => (
          <li key={e.commit} className={decision?.status === "merged" && e.laneCommit === decision.laneCommit ? "landed" : undefined}>
            <span className="pip" style={{ background: e.agent ? colourOf(e.agent) : "var(--ink-3)" }} />
            <div>
              <div className="row">
                <span><span className="who">{e.agent ?? "seed"}</span> · {e.subject}</span>
                {!watching && <button className="link" disabled={!!busy} onClick={() => undo(e.commit)}>{busy === e.commit ? "Undoing" : "Undo"}</button>}
              </div>
              <div className="when">
                {ago(e.at)}{e.approvedBy && <> · <span className="tag">approved by {e.approvedBy}</span></>}{e.reverts && <> · undoes {e.reverts.slice(0, 7)}</>}
              </div>
              {e.after !== null || e.before !== null ? (
                <div className="diff"><Changed from={e.before ?? ""} to={e.after ?? ""} /></div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
