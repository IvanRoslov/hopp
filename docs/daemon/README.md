---
component: daemon
repo: this repo, `cmd` and `internal`
last-verified: 2026-11-14
kind: leaf
up: [[INDEX]]
verified: 2026-11-14 — go test ./..., go vet ./... and the Pi extension tests on main
---

# daemon

The daemon manages tmux sessions that run agents and lets the agents message each other.

1. The daemon owns the tmux sessions that run agents and the delivery of messages between those agents. It is the first component of the harness, so everything built later sits on top of it.
2. The daemon and its CLI are one program named `hopp`. The name differs from the old rocket on purpose: rocket must keep working while hopp is developed.
3. hopp shares nothing with rocket at run time. It has its own state directory `~/.hopp` with its own socket and database, and its own tmux session names, so the two daemons never see each other's sessions.
4. The daemon launches an agent in the folder it is given and knows nothing more about that folder. It does not work with git, repositories, branches or worktrees: whoever asks for the session prepares the folder beforehand and cleans it up afterwards.
5. The daemon has no roles: it does not know the words "orchestrator" or "worker", all sessions are equal, and any session may message any other. Who manages whom is knowledge of the layer above, which also supplies the prompt for each session.
6. The one relation the daemon keeps is `parent`: which session launched which, to any depth. It is what lets a session list its children, stops the children when the parent is stopped, tells the parent when a child is stuck or has failed, and tells each agent its own id and its parent's id through the environment.
7. The daemon is ported from the old rocket, not written from scratch. Message delivery and the reading of agent screens carry a long history of debugging against real agent CLIs, and rewriting them would throw that away.
8. So far the repository holds the tmux runtime, the delivery clients and the five harness adapters (`claude-code`, `codex`, `kimi-code`, `pi`, `deepseek`), ported from rocket with their tests; there is no daemon process, store or CLI command yet. `internal/PORTED.md` records every change made to the ported code.

<!-- Grow this leaf to up to 12 facts. When it answers several separate questions,
     turn this README into a node (kind: node, 3–7 facts) and give each question its
     own leaf in this directory; the node must link every leaf, and every doc in the
     directory must be listed here once it holds three or more. -->

Code: [cmd](cmd), [internal](internal)
