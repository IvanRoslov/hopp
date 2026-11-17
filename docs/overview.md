---
kind: leaf
up: [[INDEX]]
verified: 2026-11-17 — against the code on main (e9468d7): the Makefile, daemon/cmd/hopp, app/src/main
---

# hopp: what it is and how it ships

What the product is for, who uses it, and where it runs. Each component has its own branch from the root.

1. hopp is a harness for orchestrating AI agents, built of two components: the daemon, which runs agents in tmux sessions and carries messages between them, and the desktop app, which keeps projects, tasks, long-lived agents and pipelines above it and launches their sessions through it.
2. Its user is the project author: hopp is their internal agent orchestration and the successor of the rocket project. rocket stays in use while hopp is built, so hopp must not break it.
3. hopp runs on the author's machine: one daemon per machine with its state in `~/.hopp`, started by most `hopp` commands when it is not running, and one app per store. There is no release step: `bin/hopp` is built from this repo and `make restart` rebuilds and restarts the daemon, and `make app-install-mac` builds the app and puts it in `/Applications`.

Code: [repo root](.)
