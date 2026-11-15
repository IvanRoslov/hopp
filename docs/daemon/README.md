---
component: daemon
repo: this repo, `cmd` and `internal`
last-verified: 2026-11-15
kind: node
up: [[INDEX]]
verified: 2026-11-15 — go test ./..., and a live run of all five harnesses against ~/.hopp
---

# daemon

The daemon manages tmux sessions that run agents. On `main` it launches, lists, stops and restores them; message delivery between agents is not built yet.

1. What the daemon is, what it deliberately does not know (roles, git, scenarios), the one `parent` relation, its own state in `~/.hopp`, and why it is a port of rocket rather than a rewrite. → [[docs/daemon/boundaries]]
2. How a session is launched, named, stopped, restored and reconciled after a daemon restart, the rule that keeps hopp off tmux sessions that are not its own, and what a launch writes into the folder. → [[docs/daemon/sessions]]
3. What is not on `main` yet: message delivery, activity tracking, the live event stream and the alerts to a parent. → [[docs/daemon/not-yet]]
