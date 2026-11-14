---
component: daemon
repo: this repo, `daemon`
last-verified: 2026-11-14
kind: leaf
up: [[INDEX]]
verified: 2026-11-14 — scaffold, nothing verified yet
---

# daemon

The daemon manages tmux sessions that run agents and lets the agents message each other.

1. The daemon owns the tmux sessions that run agents and the delivery of messages between those agents. It is the first component of the harness, so everything built later sits on top of it.
2. The daemon and its CLI are one program named `hopp`. The name differs from the old rocket on purpose: rocket must keep working while hopp is developed.
3. <TODO: what it depends on and what depends on it.>

<!-- Grow this leaf to up to 12 facts. When it answers several separate questions,
     turn this README into a node (kind: node, 3–7 facts) and give each question its
     own leaf in this directory; the node must link every leaf, and every doc in the
     directory must be listed here once it holds three or more. -->

Code: [daemon](daemon)
