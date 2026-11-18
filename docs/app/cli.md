---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-18 — fact 5 by make app-test on task-new-latency (launchQueue.test.ts); the rest against the code on main (670ba12): app/src/cli (EXIT 1/2/3, the role refusal, the worker defaults), main/shell/server.ts (shell.sock 0600, /tmp/hopp-<uid>/), main/cliInstall.ts (ELECTRON_RUN_AS_NODE), startText.ts (started by)
---

# The app's commands: hopp project, hopp pipeline, hopp task

A long-lived agent uses projects, pipelines and tasks the way the human does in the window, from its terminal. This leaf says what the commands do, where they run and what a task started by an agent changes; what a launch does is in [[docs/app/shell]].

1. `hopp project ls|show`, `hopp pipeline ls|show` and `hopp task ls|show|feed|new|stop|resume|finish` read the app's projects and pipelines and start and follow its tasks; every one takes `--json`. Projects and pipelines are created and edited only in the app.
2. They are external commands of `hopp` (see [[docs/daemon/boundaries]]): `hopp-project`, `hopp-pipeline` and `hopp-task` in `$HOPP_HOME/bin` are scripts that run one bundled program with the Node inside the app (`ELECTRON_RUN_AS_NODE`), so no system Node is needed. The app writes them at every start when they are missing or name another app, so of two installs (a checkout and `/Applications/hopp.app`) the one started last is the one they run; `make app-install-mac` and `make app-cli` also build `bin/hopp`, since a `hopp` older than its external commands says "unknown command".
3. While the app runs, a command asks it over the socket `shell.sock` in the app home (mode 0600, so another user cannot connect; a path too long for a socket moves to a private folder `/tmp/hopp-<uid>/`), which serves only the calls the commands need. When the app is closed, the command runs the app's own service against the same store, so both give the same answers, and a task started with the app closed is in the app when it opens.
4. The exit code is 1 for an error (an unknown project, pipeline, task or profile is named together with the ones that exist), 2 when the daemon is not running and 3 for a usage error.

### Starting a task

5. `hopp task new --project <p>` takes the brief from `--brief`, `--file` or stdin, says each slow step on stderr while it runs (fetching the clones, making the worktree, starting the orchestrator; an app older than this command answers without them) and prints the task, its orchestrator's session and the profiles it chose. The orchestrator gets the daemon's default profile unless one is given; workers get the worker profiles of the project's last task when all are still enabled, else the orchestrator's profile.
6. Run inside a hopp session, `task new` records that session (`$HOPP_SESSION_ID`) as the task's starter and labels the orchestrator `hopp.started_by`. The orchestrator is told to send the starter its questions about the request and its progress reports with `hopp send`, while the human's decisions and stage approvals still go to the human; the command tells the starter the same, and the app's task details show "Started by".
7. A session labelled `hopp.role=orchestrator` or `hopp.role=worker` cannot start a task: the command and the app's service both refuse, since tasks are not started from inside tasks. Only a long-lived agent's start text lists these commands.

### Following a task

8. `hopp task show` gives a task's state, its sessions, branch, folder, what it started from, who started it, its pipeline stage and its open asks; `hopp task feed` lists its posts, asks and artifacts in time order. `hopp task ls` lists the active tasks (`--all` adds finished and hidden ones; `--project` narrows it).

Code: [cli](app/src/cli), [shell](app/src/main/shell), [scripts](app/scripts)
