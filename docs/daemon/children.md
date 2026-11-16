---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on main and go test ./... (Plan 5)
---

# What a child takes from its parent

A session launched with a parent starts with some of the parent's settings, so a tree of sessions keeps its marks without every launch repeating them.

1. A child starts with its parent's labels. A label given at launch wins over the parent's on the same key, so `hopp run --label k=v` changes one mark and keeps the rest.
2. A label given at launch with an empty value (`--label k=`) removes that key from what the child inherits. An empty label is never stored, also on a launch without a parent.
3. The child keeps its own copy of the labels from the moment of launch, so removing the parent later leaves the child's labels as they were.

Code: [session](daemon/internal/session), [cli](daemon/internal/cli)
