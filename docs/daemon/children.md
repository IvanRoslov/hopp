---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on main and go test ./... (Plan 5)
---

# What a child takes from its parent

A session launched with a parent starts with some of the parent's settings, so a tree of sessions keeps its marks and its folder limit without every launch repeating them.

1. A child starts with its parent's labels. A label given at launch wins over the parent's on the same key, so `hopp run --label k=v` changes one mark and keeps the rest.
2. A label given at launch with an empty value (`--label k=`) removes that key from what the child inherits. An empty label is never stored, also on a launch without a parent.
3. The child keeps its own copy of the labels from the moment of launch, so removing the parent later leaves the child's labels as they were.

### Folders a session may launch in

4. A session may carry a list of folders (`hopp run --spawn-dir <path>`, repeatable). When the list is not empty, every session it launches must be in one of those folders or under one; any other folder refuses the launch with `dir_not_allowed`, and the message lists the allowed folders so the agent can tell the human what it needs.
5. The limit is read from the session the request comes from (its `$HOPP_SESSION_ID`), not only from the parent, so `--no-parent` or `--parent <other>` does not lift it. A request with no calling session gets its parent's limit.
6. A child keeps the limit of the session that launched it, or narrows it to folders inside that limit; a folder outside it refuses the launch with `spawn_dirs_not_allowed`, so a limit can never be widened down the tree.
7. Folders are compared after resolving symlinks and `..`, and by whole path segments, so a link inside an allowed folder that points out of it is outside, and `/a/work-other` is not inside `/a/work`. `hopp restore` is not checked, because it relaunches in the folder the session already had.

Code: [session](daemon/internal/session), [store](daemon/internal/store), [api](daemon/internal/api), [cli](daemon/internal/cli)
