// Calls to the Worker's /api. Acting sends the demo key while Cloudflare Access is not in front.

export type MainCommit = {
  hash: string;
  parents: string[];
  subject: string;
  agent?: string;
  source?: string;
  resolution?: string;
  approvedBy?: string;
  reverts?: string;
  laneCommit?: string;
  paths: string[];
  at: number;
};

export type LaneStatus = { agent: string; since: string | null; dirty: number; merged: number; held: string | null; error: string | null };

export type State = {
  repo: string;
  main: MainCommit[];
  lanes: LaneStatus[];
  approvals: { id: number; agent: string; path: string; createdAt: number; hasProposal: boolean }[];
};

export type Conflict =
  | { kind: "delete"; detail: string }
  | { kind: "field"; key: string; ours: string; theirs: string }
  | { kind: "overlap"; section: string; base: string; ours: string; theirs: string }
  | { kind: "order"; detail: string };

export type Approval = {
  id: number;
  agent: string;
  laneCommit: string;
  path: string;
  baseText: string | null;
  oursText: string | null;
  theirsText: string | null;
  conflicts: Conflict[];
  proposal: string | null;
  status: "open" | "resolved" | "superseded" | "merged";
  resolution: "llm" | "human" | null;
  approvedBy: string | null;
};

export type HistoryEntry = {
  commit: string;
  subject: string;
  agent?: string;
  source?: string;
  resolution?: string;
  approvedBy?: string;
  reverts?: string;
  at: number;
};

const KEY = "braid.demoKey";

/** A link carrying #key=… stores the demo key on this device (until Access is in front). */
export function captureDemoKey() {
  const m = /[#&]key=([^&]+)/.exec(location.hash);
  if (!m) return;
  try { localStorage.setItem(KEY, decodeURIComponent(m[1])); } catch { /* private mode: act fails with 401 */ }
  history.replaceState(null, "", location.pathname + location.hash.replace(/[#&]key=[^&]+/, "").replace(/^#?$/, "#/"));
}

function demoKey(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function act<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const k = demoKey();
  if (k) headers["x-demo-key"] = k;
  const r = await fetch(`/api/act${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `${r.status}`);
  return data as T;
}

export const api = {
  state: () => get<State>("/state"),
  approval: (id: number) => get<Approval>(`/approvals/${id}`),
  history: (path: string) => get<HistoryEntry[]>(`/history?path=${encodeURIComponent(path)}`),
  record: (path: string, ref = "main") => get<{ path: string; after: string | null; before?: string | null }>(`/record?path=${encodeURIComponent(path)}&ref=${ref}`),
  resolve: (id: number, action: "approve" | "ours" | "theirs" | "edit", text?: string) => act<Approval>(`/approvals/${id}`, { action, text }),
  undo: (commit: string, path?: string) => act<{ laneCommit: string }>(`/undo`, { commit, path }),
};
