# hopp Index

Read this whole. Each fact links one level down; follow only the branches your task touches. The rules for reading and writing the tree are in `CLAUDE.md`.

1. hopp is a harness for orchestrating AI agents, made of a daemon and a desktop app; what it is for, who uses it and how it ships. → [[docs/overview]]
2. daemon: the program `hopp` runs agents in tmux sessions, carries messages between them, watches what each agent does, brings agents' questions to the human and keeps posts, artifacts, lessons, model profiles and token usage, and the same program reads the tool catalog; it knows no roles, projects or tasks. → [[docs/daemon/README]]
3. app: the desktop app is the other half: projects, tasks that run in a worktree of a folder or a GitHub clone, long-lived agents, pipelines with a feed, stages and artifacts, model profiles and lessons of two kinds, the `hopp project|pipeline|task` commands agents use, and the window where the human works with all of it through the daemon's socket. → [[docs/app/README]]
4. The hard rules you must never break are a reference list outside the tree. → [[docs/invariants]]
5. Which tool to use to build, test and ship. → [[docs/agent-toolbox]]
6. Step-by-step runbooks for recurring operations, including the standing rules for proving a change and for running parallel workers. → [[docs/playbooks/README]]
7. What past runs taught us, until each lesson becomes a fact or a rule. → [[docs/lessons/README]]
8. How this knowledge base is organized and why it works. → [[docs/meta/knowledge-base]]
9. Docs and code share this repo: the vault is the root-level `*.md` files and `docs/`, and a leaf's `Code:` line links a directory of this repo. → [[CLAUDE]]

---

## Outside the tree

These are not facts to walk; a fact or a task sends you to them.

- [[docs/inbox/README]] — unprocessed notes, waiting to be triaged into the tree.
- [[docs/meta/replication-blueprint]] — why this structure works and how to roll it out elsewhere.
