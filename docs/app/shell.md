---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-20 — against the code on add-task-workers (d57becf): store.ts, service.ts (createTask, uniqueId, the launch and its cleanup, addTaskWorkers, resumeTask), startText.ts; facts 1–8, 10, 11 earlier against main (e9468d7)
---

# Projects, tasks and long-lived agents

The daemon knows sessions, folders and labels; the app adds projects, tasks and long-lived agents on top and maps each onto daemon sessions. This leaf says what the app keeps and what a task's launch does; long-lived agents: [[docs/app/agents]]; a task with a pipeline: [[docs/app/pipelines]]; repositories picked from GitHub: [[docs/app/github]].

### What the app keeps

1. Projects, pipelines, tasks and long-lived agents live in `$HOPP_HOME/shell/state.json`, versioned, written atomically and synced to disk, and the page is told after every change. Every change takes the lock file `state.lock` and starts from the file, so the app and a `hopp task` run while it is closed (see [[docs/app/cli]]) never lose each other's changes, and the app re-reads a change made outside it. The state before each change stays in `state.json.bak`: when `state.json` cannot be read (empty after a crash, corrupt) the app uses the `.bak`, and it refuses to start only when neither can be read, or the file comes from a newer app. Only one app runs per store; a second launch brings the first window forward. `HOPP_APP_HOME` puts the store (and that lock) in another folder while the daemon, worktrees, tools and artifacts stay in the hopp home, so a second app can work against a live daemon without touching the open app's store.
2. The store keeps only what the daemon cannot know: whether a task runs, waits or has stopped is read from its sessions.
3. A project has a name, a slug made from the name, a description, an optional repository for the orchestrator, repositories for workers (they need the orchestrator's) and guardrails. Each repository is checked to be a git repository and stored as its top folder, and the slug cannot change once the project has tasks.

### Launching a task

4. A task's session id is the session name given under "More", else made from the title, and gets `-2`, `-3`, … until no daemon session, task, agent, mailbox, folder or branch uses it; it is at most 40 characters. Two launches at once, even from two processes, never get the same id.
5. With a repository the task runs in a new worktree on branch `hopp/<id>` from the repository's current HEAD (a clone picked from GitHub: from `origin/<branch>`, after a fetch), under `$HOPP_HOME/worktrees/<project>/<id>`; without one, in the folder `$HOPP_HOME/work/<project>/<id>`. The task records the commit its worktree started from (and, for a folder, the branch), and its orchestrator is told it at start. The worktree stays after the task is finished.
6. The orchestrator is launched with the human's request as its first message, the labels `hopp.project`, `hopp.task` and `hopp.role=orchestrator` (and `hopp.started_by` when an agent started the task), and the folder limit (see [[docs/daemon/children]]): the project's repositories, `$HOPP_HOME/worktrees/<project>` and the task's folder.
7. Its start text is built in layers (hopp, role, project, tools, then the human's extra prompt). The workers' start texts are files in `$HOPP_HOME/shell/tasks/<id>/`, one per harness among the worker profiles, and the orchestrator's text gives the exact commands to make a worker's folder and launch it with one of those profiles and files. Workers never ask the human; the orchestrator asks, and says the work is ready with an ask offering Accept and Revise. The orchestrator's text also repeats the brief, since a resumed orchestrator starts with its text and no conversation.
8. A launch that fails before the orchestrator's session was requested removes exactly what it made (the worktree, its branch, the folder, the start-text files) and stores no task; it also fails before making anything when `hopp tools prompt` cannot be read. Once the session was requested, nothing is removed while it may exist: a late answer is checked with the daemon, a launched session is recorded as a task, and when the daemon cannot tell, the error names the session and keeps its folder.

### After the launch

9. Stop kills the task's session tree, Resume restores the orchestrator and sends it a message to find where the work stands (a restored agent starts with no conversation), and Finish ends the tree as done and moves the task to Recent; a finished task cannot be resumed, and a running one cannot be removed from the list. Worker profiles can be added to a task that is not finished: the app writes the start text of a new harness, tells a running orchestrator at once, and repeats the added profiles in the Resume message, since a restored orchestrator starts with its original text.
10. The tool catalog is read with `hopp tools … --json` under the app's `HOPP_HOME`, so the app and the agents see the same tools; the app writes the rules file itself.
11. Every call from the page is checked in the main process: a malformed call gets an error back and never throws there.

Code: [shell](app/src/main/shell), [app](app)
