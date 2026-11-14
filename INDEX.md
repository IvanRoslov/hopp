# hopp Index

Read this whole. Each fact links one level down; follow only the branches your task touches. The rules for reading and writing the tree are in `CLAUDE.md`.

1. hopp: Харнесс для оркестрации агентов. What it is for, who uses it and how it ships. → [[docs/overview]]
2. daemon: Демон: запускает агентов в tmux-сессиях с выбранным харнесом и моделью и доставляет сообщения между сессиями. <TODO: the one fact an agent most needs about it.> → [[docs/daemon/README]]
3. cli: Тонкий клиент демона, которым пользуются человек и агенты. <TODO: the one fact an agent most needs about it.> → [[docs/cli/README]]
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
