---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the routes and commands on main (1ddc9bd)
---

# What the daemon does not do yet

Messaging with mailboxes, activity, the event stream, the chat feed, answering an agent's screen, decision requests, token usage and removing ended sessions are built; these parts of the design are not.

1. The API listens only on the daemon's Unix socket, with no TCP listener and no authentication, so only processes of the same user on the same machine can reach it.
2. The layer above the daemon (roles, tasks, worktrees, who manages whom) is not part of hopp yet. The daemon already gives it what it needs to build on: labels, the `parent` relation, the event log and the live event stream.

Code: [api](daemon/internal/api), [cli](daemon/internal/cli), [monitor](daemon/internal/monitor)
