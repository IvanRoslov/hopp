---
last-verified: 2026-11-16
---

# First task in the app

## When to use

You want to run work through the hopp desktop app for the first time: create a project, launch a task, answer its questions, and finish it. What the app is and what it keeps: [[docs/app/README]]; the window in detail: [[docs/app/page]]; what a launch does: [[docs/app/shell]].

## Prerequisites

- tmux, git and the `hopp` command on your `PATH` (`make install`), and the agents of the model profiles you will use (Claude Code, Codex, …). Commands: [[docs/agent-toolbox]].
- The app installed once: `make app-install` from the repository root.
- The app keeps everything in `$HOPP_HOME` (by default `~/.hopp`), next to the daemon. To try it without touching your real data, start it with `HOPP_HOME` set to an empty folder.

## Steps

1. **Start the app.** Either `make app-dev` (a development window), or `make app-pack` once and then double-click `app/dist/hopp-darwin-arm64/hopp.app` (unsigned and built on this Mac, so it opens directly), or `make app-install-mac` to put it in `/Applications`. Only one copy runs at a time; opening it again brings the first window forward.
   - If the left column says "The hopp daemon is not running", press **Start daemon** (it runs `hopp daemon start` with your login shell's `PATH`), or run it yourself; the app reconnects on its own.
2. **Create your first project.** With no project the window shows only this form.
   - **Name** — anything; **Slug** follows the name until you edit it (it names folders and branches).
   - **Description** — a sentence the orchestrator reads at start.
   - Under **Advanced**:
     - **Worktree for the orchestrator** — one git repository. Each task gets a new worktree of it, on a new branch, at the repository's current commit: uncommitted changes in your checkout are not included. Leave it empty and tasks run in a plain folder.
     - **Worktrees for workers** — more repositories, one per line, where the orchestrator may launch workers; empty means workers work in the orchestrator's repository.
     - **Guardrails** — text every orchestrator of this project gets at start (for example "no paid actions without my go").
   - An error appears next to the field it is about; nothing you typed is lost.
3. **Launch a task.** In **New task**:
   - write **What needs to be done?** (the first line becomes the title);
   - pick **Project**, **Orchestrator** (an enabled model profile; it cannot be changed after launch) and **Workers** (the profiles the orchestrator may launch workers with);
   - **Pipeline** stays **No pipeline** for a plain task;
   - **More** holds a **Title**, a **Session name** (the orchestrator's session id) and an **Extra system prompt**.
   - Press the arrow button or ⌘↩. The task appears under **Work** and opens, reading *starting* until the daemon lists its session; the terminal then attaches.
4. **Find its files.** With a repository: the worktree is `$HOPP_HOME/worktrees/<project>/<task id>` on branch `hopp/<task id>`. Without one: `$HOPP_HOME/work/<project>/<task id>`. The orchestrator's and workers' start texts are in `$HOPP_HOME/shell/tasks/<task id>/`. `···` → **Task details** shows the folder and the branch.
5. **Work with it.** The terminal on the right is the orchestrator's own tmux session: type into it as into any terminal. The session picker above it switches to any worker of the task, with each session's state in words. Closing the window or quitting the app never stops a session.
6. **Answer questions.** Everything waiting for you is listed at the top of the left column under **Waiting for you**, with the task under each question. Click a row: the task opens with the **Questions** column on the session that asked. Answer with the buttons, or type an answer when there are none. When the orchestrator thinks the work is ready it asks "Ready for review: …" (what is done and where) with **Accept** and **Revise**, in the language of your brief.
7. **Stop, resume, finish.** In `···`:
   - **Stop task** asks first and names how many child sessions stop with it;
   - **Resume** restarts a stopped orchestrator with a fresh conversation; it reads its branch, workers and messages to find where the work stands;
   - **Finish task** stops everything and moves the task to **Recent** (the worktree and branch stay);
   - **Remove from list** appears once the orchestrator's session no longer runs.
8. **A task with a pipeline.** Pick a **Pipeline** in New task (three starters come with the app: Development, Landing page, Promo video; edit them under **Pipelines**). Its stages show before you launch.
   - The task opens on its **feed**: what the orchestrator posts, its questions, its artifacts. **Write to the orchestrator** at the bottom sends it a message.
   - When a stage is done the orchestrator submits it: the feed shows the submitted versions with **Accept**, **Return** (say what to fix) and **All artifacts**.
   - **Stages** opens the stages and their state; **Artifacts** opens every version with a viewer (image, video, HTML, text), a version picker and side-by-side compare; **Terminal** opens the orchestrator's terminal.
9. **Tools and preferences.** **Settings → Tools**: write your **Preferences** (which tool or model to use for what; saved as `$HOPP_HOME/tools/rules.md`, which agents read), switch tools on or off, see which are **paid** (an agent asks you with `hopp ask` before each paid call), and click a tool for its usage.
10. **Lessons.** Agents record what would have made the work better with `hopp lesson`; read them in **Settings → Lessons** and mark each as done once you have acted on it.

## Verify

- The task's row under **Work** shows a ring (working or idle), not *session gone*.
- `hopp ls` lists the task's session; with a repository, `git -C <repo> worktree list` shows `$HOPP_HOME/worktrees/<project>/<task id>` on `hopp/<task id>`.
- After **Finish task**, the task is under **Recent** and `hopp ls` no longer lists it as running.

## Rollback / if it goes wrong

- A launch that fails removes what it made (the worktree, its branch, the folder, the start texts) and shows the reason under the form; fix it and launch again.
- A stopped task resumes from `···` → **Resume**; a finished one cannot, and its worktree stays for you to keep or delete with `git worktree remove`.
- The app's own data is `$HOPP_HOME/shell/state.json` (with `state.json.bak` beside it); the daemon's data stays in `$HOPP_HOME` and the app never writes to the daemon's database.
