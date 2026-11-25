---
component: app
repo: this repo, `app/` (Electron, React, TypeScript)
last-verified: 2026-11-17
kind: node
up: [[INDEX]]
verified: 2026-11-17 — against the code on main (e9468d7), make app-test there
---

# app

The desktop app is half of hopp: on top of the daemon's sessions it keeps projects, tasks, long-lived agents, pipelines, model profiles and lessons, launches the sessions they need, and is the human's window onto all of it. It reaches the daemon only through its socket.

1. How the app talks to the daemon (only the socket, the event stream, a daemon that is not running), the login-shell `PATH` and locale it gives itself, and the make targets that install, run, pack and test it. → [[docs/app/connection]]
2. What the app keeps and what a launch does: projects, tasks that run in a new worktree of a folder or a GitHub clone, and the start texts of their orchestrators and workers. → [[docs/app/shell]]; repositories picked from GitHub and cloned by the app → [[docs/app/github]]; long-lived agents, named by their session id → [[docs/app/agents]]
3. A task that follows a pipeline: the stages, the labels that are the contract with the orchestrator, the task's feed, submissions and artifacts. → [[docs/app/pipelines]]
4. The window: the left column, the forms and Settings → [[docs/app/page]]; a task's or an agent's screen with its header, its terminal and its questions → [[docs/app/workview]]; files and folders attached to a new task or a line in the feed → [[docs/app/attachments]]
5. Model profiles (add, copy with another effort, import, switch, default) → [[docs/app/models]]; lessons about hopp and about each project, what counts as a lesson and why no agent is shown them → [[docs/app/lessons]]
6. The commands `hopp project`, `hopp pipeline` and `hopp task` a long-lived agent uses from its terminal, with the app open or closed. → [[docs/app/cli]]
