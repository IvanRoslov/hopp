---
kind: leaf
up: [[INDEX]]
verified: 2026-11-15 — against the code on main and a live run against ~/.hopp
---

# hopp: what it is and how it ships

What the product is for, who uses it, and where it runs. Each component has its own branch from the root.

1. hopp is a harness for orchestrating AI agents. Its first component is the daemon; nothing else exists yet.
2. Its user is the project author: hopp is his internal agent orchestration and the successor of the rocket project. rocket stays in use while hopp is built, so hopp must not break it.
3. hopp runs on the author's machine as one daemon per machine, with its state in `~/.hopp`; any `hopp` command starts the daemon when it is not running. There is no release step yet: the program is `bin/hopp`, built from this repo, and `make restart` rebuilds and restarts the daemon.

Code: [repo root](.)
