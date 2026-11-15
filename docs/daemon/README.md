---
component: daemon
repo: this repo, `daemon/` (`daemon/cmd` and `daemon/internal`)
last-verified: 2026-11-15
kind: node
up: [[INDEX]]
verified: 2026-11-15 — go test ./... on a01bc9a, and the live delivery checks of all five harnesses against ~/.hopp
---

# daemon

The daemon manages tmux sessions that run agents. On `main` it launches, lists, stops and restores them, delivers messages between them, tracks what each agent is doing and tells a parent when a child needs help.

1. What the daemon is, what it deliberately does not know (roles, git, scenarios), the one `parent` relation, its own state in `~/.hopp`, and why it is a port of rocket rather than a rewrite. → [[docs/daemon/boundaries]]
2. How a session is launched, named, stopped, restored and reconciled after a daemon restart, the rule that keeps hopp off tmux sessions that are not its own, and what a launch writes into the folder. → [[docs/daemon/sessions]]
3. How a message travels from one session to another: the three transports, when it is `accepted` and `delivered`, what holds it back, large messages, and what the sender learns when it fails. → [[docs/daemon/messaging]]
4. How the daemon knows what each agent is doing, what a parent is told about a stuck or failed child, and how to follow the event log live. → [[docs/daemon/activity]]
5. What is not on `main` yet: a network listener with authentication, and the layer of roles and tasks above the daemon. → [[docs/daemon/not-yet]]
