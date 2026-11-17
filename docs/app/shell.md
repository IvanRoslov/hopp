---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-16 — make app-test on the shell-main branch (fake daemon, temp HOPP_HOME, throwaway git repositories)
---

# Projects, tasks and long-lived agents

The daemon knows sessions, folders and labels; the app adds projects, tasks and long-lived agents on top and maps each onto daemon sessions. This leaf says what the app keeps and what a launch does; a task with a pipeline, its feed, stages and artifacts: [[docs/app/pipelines]].

### What the app keeps

1. Projects, pipelines, tasks and long-lived agents live in `$HOPP_HOME/shell/state.json`, versioned, written atomically and synced to disk, and the page is told after every change. The state before each change stays in `state.json.bak`: when `state.json` cannot be read (empty after a crash, corrupt) the app uses the `.bak`, and it refuses to start only when neither can be read, or the file comes from a newer app. Only one app runs per hopp home; a second launch brings the first window forward.
2. The store keeps only what the daemon cannot know: whether a task runs, waits or has stopped is read from its sessions.
3. A project has a name, a slug made from the name, a description, an optional repository for the orchestrator, repositories for workers (they need the orchestrator's) and guardrails. Each repository is checked to be a git repository and stored as its top folder, and the slug cannot change once the project has tasks.

### Launching a task

4. A task's session id is the session name given under "More", else made from the title, and gets `-2`, `-3`, … until no daemon session, task, agent, mailbox, folder or branch uses it; it is at most 40 characters.
5. With a repository the task runs in a new worktree on branch `hopp/<id>` from the repository's current HEAD, under `$HOPP_HOME/worktrees/<project>/<id>`; without one, in the folder `$HOPP_HOME/work/<project>/<id>`. The worktree stays after the task is finished.
6. The orchestrator is launched with the human's request as its first message, the labels `hopp.project`, `hopp.task` and `hopp.role=orchestrator`, and the folder limit (see [[docs/daemon/children]]): the project's repositories, `$HOPP_HOME/worktrees/<project>` and the task's folder.
7. Its start text is built in layers (hopp, role, project, tools, then the human's extra prompt). The workers' start texts are files in `$HOPP_HOME/shell/tasks/<id>/`, one per harness among the worker profiles, and the orchestrator's text gives the exact commands to make a worker's folder and launch it with one of those profiles and files. Workers never ask the human; the orchestrator asks, and says the work is ready with an ask offering Accept and Revise.
8. A launch that fails before the orchestrator's session was requested removes exactly what it made (the worktree, its branch, the folder, the start-text files) and stores no task; it also fails before making anything when `hopp tools prompt` cannot be read. Once the session was requested, nothing is removed while it may exist: a late answer is checked with the daemon, a launched session is recorded as a task, and when the daemon cannot tell, the error names the session and keeps its folder.

### After the launch

9. Stop kills the task's session tree, Resume restores the orchestrator, and Finish ends the tree as done and moves the task to Recent; a finished task cannot be resumed, and a running one cannot be removed from the list.
10. A long-lived agent's name is its session id and its mailbox: creating one registers the mailbox, starting it restores its session if it ran before or launches it in its folder with only the hopp and tools layers. No code depends on an agent's name.
11. The tool catalog is read with `hopp tools … --json` under the app's `HOPP_HOME`, so the app and the agents see the same tools; the app writes the rules file itself.
12. Every call from the page is checked in the main process: a malformed call gets an error back and never throws there.

Code: [shell](app/src/main/shell), [app](app)
