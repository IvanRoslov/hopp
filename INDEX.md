# hopp Index

Read this whole. Each fact links one level down; follow only the branches your task touches. The rules for reading and writing the tree are in `CLAUDE.md`.

1. hopp: A harness for orchestrating AI agents. What it is for, who uses it and how it ships. → [[docs/overview]]
2. daemon: The daemon manages tmux sessions that run agents and delivers messages between them, watching what each agent does and telling a parent when a child is stuck. The daemon and its CLI are one program named `hopp`, so the old rocket keeps working while hopp is built. → [[docs/daemon/README]]
3. app: The desktop app shows the daemon's sessions, opens one in a real terminal as one more tmux client, and answers its questions, talking to the daemon only over its socket. → [[docs/app/README]]
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
