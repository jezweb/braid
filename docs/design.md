# braid design

Many agents write one shared memory. Each writes only to its own fork (a lane); one merge agent folds lanes into `main`; a person decides the rare real conflict. Everything else calls four primitives built on one contract.

## The contract

Every write is an envelope naming exactly what it changed and what it started from (`src/contract.ts`):

```ts
type Envelope = {
  agent: string                                                       // commit author
  changes: { path: string; base: string | null; content: string | null }[]  // base: blob read from; null content deletes
  reason: string                                                      // commit subject
  source?: string                                                     // evidence
}
```

One envelope is one commit on the writer's lane, with trailers `Agent:`, `Source:` and one `Record-Path: <path> <base-blob>` per change. Only the merge agent writes `main`. Its merge commit copies the lane's trailers and adds `Lane-Commit:`, `Resolution: clean | field | llm | human` and, when a person decided, `Approved-By:`. An undo adds `Reverts:`.

Why trailers on `main` and not only on the lane: Artifacts' `log()` follows first parents, so history is read from `main`'s merge commits; the lane commit is the second parent.

## Why a fork per agent

Artifacts tokens are scoped to a repo with only `read` and `write`, and there is no branch protection. A branch per agent would let any agent push `main`. A fork per agent (`<repo>--<agent>`) means an agent's token can reach only its own lane. The merge agent alone holds a token for the canonical repo.

## Components

| Piece | Where | Job |
|---|---|---|
| `Store` | `src/git/store.ts` | Bare in-memory git: shallow fetch from several remotes, read paths, write trees and commits, push fast-forward |
| merge table | `src/merge.ts` | One path, three texts (base, main now, the writer's) to clean content or named conflicts. Pure |
| `mergeLane` | `src/merge-lane.ts` | Folds a lane's unmerged commits into `main`, oldest first, one two-parent merge each, one push |
| `Lane` DO | `src/lane.ts` | One per agent. Owns the fork and its token, serialises writes, keeps the agent's pending writes so its own reads see them |
| `MergeAgent` DO | G2 | One per canonical repo. Serial queue over lanes, `since` per lane, approvals, proposals |

## The primitives

- **write(envelope)** goes to the agent's `Lane`. The DO validates it, applies the changes to the lane's tree, commits with the lane trailers and pushes to the fork. Writes from one agent never race: the DO runs them one at a time. Returns the lane commit.
- **read(agent, path)** returns `{ content, base }`. The agent's own pending (unmerged) writes win; otherwise `main` through the binding. `base` is the blob to name in the next envelope, so a second write before the first merges never conflicts with itself.
- **history(path)** reads `main`'s log and keeps commits whose `Record-Path:` names the path.
- **revert(agent, commit, path)** is a write: content is the path as it was before `commit`, and base is the blob `commit` produced (not main's blob now, which would let an undo erase a later edit). If main has not touched the path since, the undo merges clean; if a later edit touched other lines it still merges; if it overlaps, a person decides. An undo of an undo restores.

## Merge rules

Per path, from the base blob, `main`'s blob now and the writer's content (`src/merge.ts` heads with the full table). `main` moves fast-forward only: a rejected push means fetch again and retry, never force.

`mergeLane` starts from `since`, the last lane commit already merged (at first, the commit the fork started from), and walks the lane's first-parent chain. Merging only the tip would be wrong twice: a re-run would resurrect a record `main` deleted since, and a tip whose parent is unmerged cannot be pushed (its parent is missing on `main`).

## Proof gates

| Gate | Yes when |
|---|---|
| G0 | In a deployed Worker: fork, advance `main` twice, commit on the fork, push a two-parent merge, `log({ref:"main"})` shows it with its trailers. **Passed 3 Oct 2026** |
| G1 | 20 concurrent writes from 5 lanes land on their forks in order, none lost; a second write before the first merges carries the right base |
| G2 | All 20 merge; a scripted overlap gives exactly one approval; stacked writes give none |
| G3 | Approval on a phone lands `Resolution: llm` and `Approved-By:`; undo, undo of undo, undo after a later edit becomes an approval |

## Measured on Artifacts (open beta, 3 Oct 2026)

`create()` about 1.5 s; `fork()` about 3.8 s, readable 35 ms later for a small repo; an isomorphic-git push 0.3 to 0.6 s; a merge (two shallow fetches and a push) 0.4 s; `log()` and `readFile()` about 20 ms.
