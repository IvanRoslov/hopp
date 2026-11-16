---
component: daemon
repo: this repo, `daemon/` (`daemon/cmd` and `daemon/internal`)
last-verified: 2026-11-15
kind: node
up: [[INDEX]]
verified: 2026-11-15 — go test ./... on 1ddc9bd, the live delivery checks of all five harnesses and the Plan 4 live checks against ~/.hopp
---

# daemon

The daemon manages tmux sessions that run agents. On `main` it launches, lists, stops, restores and removes them, delivers messages between them, tracks what each agent is doing, tells a parent when a child needs help, and brings agents' questions to the human.

1. What the daemon is, what it deliberately does not know (roles, git, scenarios), the one `parent` relation, its own state in `~/.hopp`, and why it is a port of rocket rather than a rewrite. → [[docs/daemon/boundaries]]
2. How a session is launched, named, stopped, restored, reconciled after a daemon restart and removed so its id can be used again, the rule that keeps hopp off tmux sessions that are not its own, and what a launch writes into the folder. → [[docs/daemon/sessions]]; what a child takes from its parent at launch, labels and the folders it may launch in. → [[docs/daemon/children]]
3. How a message travels from one session to another: the three transports, when it is `accepted` and `delivered`, what holds it back, large messages, mailboxes for a session that is not running, and what the sender learns when it fails. → [[docs/daemon/messaging]]
4. How the daemon knows what each agent is doing, what a parent is told about a stuck or failed child, and how to follow the event log live. → [[docs/daemon/activity]]
5. What the human sees and decides: the chat feed of a session, answering the question an agent's screen waits on, decision requests from agents (`hopp ask`), and `hopp waiting` as the one list of what waits for the human. → [[docs/daemon/human]]
6. How many tokens each session and each tree of sessions used, per model, and when that is counted. → [[docs/daemon/usage]]
7. What is not on `main` yet: a network listener with authentication, and the layer of roles and tasks above the daemon. → [[docs/daemon/not-yet]]
