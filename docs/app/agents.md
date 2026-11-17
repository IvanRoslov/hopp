---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — against the code on main (e9468d7): createAgent, startAgent, renameAgent and removeAgent in app/src/main/shell/service.ts, and a search of app/ and daemon/ for any agent name in code
---

# Long-lived agents

A long-lived agent stands above projects: it runs in its own folder, where its role and context live, and keeps one session and one mailbox under its name. Its screen: [[docs/app/workview]].

1. An agent's name is its session id and its mailbox name: creating one registers the mailbox, and starting it launches its session in its folder with only the hopp and tools layers of the start text, labelled `hopp.agent=<name>`.
2. No code depends on an agent's name: an agent such as `cto` is not special to the system, and its role comes only from the files of its folder and what it is told.
3. Starting an agent whose session ran before restores that session, and the restored agent is told that its conversation is gone and to read its mailbox; a session that ended as done cannot be restored and the app says how to start it fresh.
4. Creating or renaming an agent refuses, next to the name, a name the daemon would refuse: a hopp session of that id in any state, or a live tmux session of that name outside hopp. A Start the daemon refuses for such a tmux session says so in the same words, and the agent's screen offers Rename and Remove agent beside the reason.
5. Only an agent that is off can be renamed or removed. The old mailbox goes with it only when it holds no letters, since the daemon cannot move letters and removing a mailbox deletes them.

Code: [shell](app/src/main/shell), [daemon client](app/src/main/daemon)
