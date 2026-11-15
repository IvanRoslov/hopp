---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the code on main (1ddc9bd) and the live checks of 2026-11-15 against ~/.hopp
---

# Token usage per session

hopp counts the tokens each session's agent used, so a human can see what a session or a whole tree of sessions cost.

1. Usage is read from the agent's own journals in the session's folder, counting only records written since the session was launched. It is kept per model as input, cache write, cache read, output and reasoning tokens and a message count.
2. A session is counted 15 seconds after it ends, and that count is final. A sweeper every 10 minutes counts ended sessions that have no final count yet, including ones that ended before usage was collected; a failed count is retried at most three times, an hour apart.
3. A running session is counted only on request (`hopp usage --collect`), and that snapshot is not final.
4. A re-count that finds no journal or fails keeps what was counted before, because Claude Code deletes old journals and a re-count must not wipe what was counted; a count that failed halfway is never stored. A session whose journals never held anything to count shows `missing`.
5. `hopp usage` prints one line per session and model with a total; `--tree <id>` keeps a session and all its descendants and sums them, and `--label` narrows by labels.

Code: [usage](daemon/internal/usage), [store](daemon/internal/store), [api](daemon/internal/api), [cli](daemon/internal/cli), [agent](daemon/internal/agent)
