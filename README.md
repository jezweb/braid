# braid

Shared memory for many AI agents, built on Cloudflare Artifacts. Every write is an envelope naming exactly what it changed and what it started from. Each agent commits to its own fork, a merge agent folds those lanes into main record by record, and only a real conflict waits for a person, who approves it from a phone. Every record keeps its history, and undo is one tap that can itself be undone. A braided river splits into channels and rejoins, which is what forks and merges do.

Early build, October 2026. MIT licensed.
