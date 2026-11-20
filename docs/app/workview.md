---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-20 — fact 3 against the code on add-task-workers (d57becf): TaskView (TaskDetails, AddWorkers); the rest against the code on main (670ba12): WorkView, TaskView, Agents, TaskBase, questions/Panel and AskActions (Other…, Not relevant), the terminal; make app-test there
---

# A task's or an agent's screen

What the human sees while working with one task (without a pipeline; a pipeline task: [[docs/app/pipelines]]) or one long-lived agent: a header, the terminal of a session and its questions.

### The header

1. The header is one row: the title (cut with an ellipsis), Stop (which asks first; for a task it names the number of child sessions) or Start or Resume, `Questions · N`, the session picker naming each session's state, a quiet status cut with its whole text in the tooltip, and the `···` menu.
2. An error, or the warning that a clone could not be fetched before the task started (with the reason, until dismissed for that task), takes a second header line only while it is there; the terminal starts right under the header.
3. A task's menu holds Finish, Remove from list (once its orchestrator's session no longer runs) and Task details; the details say what the worktree started from (`origin/main · 9d10cd1 · 5 minutes ago`, or `HEAD (<branch>)` for a folder), and let the human add enabled worker profiles to a task that is not finished.
4. A long-lived agent shows Start with the status "Off" and the number of letters waiting for it, and Stop when it runs; Rename and Remove agent are in its menu while it is off. A Start refused for a tmux session outside hopp offers Rename and Remove agent beside the reason.

### The terminal

5. A session's terminal is one more tmux client: the app runs the attach command the daemon returns in a pseudo-terminal, without the `TMUX` variable, so typing in it is typing into the session.
6. Closing a terminal, switching sessions, closing the window or quitting the app hangs up that client, so tmux detaches it and the session keeps running.
7. The terminal changes size only when its own box does (the window, a column opening or closing, the human dragging a column, the header taking or giving back its second line); a question arriving or the list updating never resizes it.
8. While another tmux client of a different size is attached, the window takes tmux's `window-size` rule (by default `latest`: the size of the client used last), and the larger client shows dots where the window does not reach.
9. When the session ends or the human detaches, the terminal prints one line saying it closed; after a detach Reattach opens it again while the session runs, and a session that runs again (Resume, Start) attaches by itself.

### Questions and columns

10. `Questions · N` counts the selected session's open asks plus one when its screen waits on a question; the column it opens answers both (the screen question through the daemon's quiz answer, asks through the ask answer), and a refused answer shows the daemon's message in place.
11. Every open ask, in the column and in a task's feed, also offers "Other…", an answer in the human's own words when none of its options fits, and a quiet "Not relevant" that closes it without an answer after a one-line confirmation, tells the asker not to wait, and takes it out of "Waiting for you".
12. The questions (or details) column and the left column can be dragged to new widths, or moved with the arrow keys, and the widths are remembered; with a column open the session picker moves to the terminal's own head.

Code: [shell views](app/src/renderer/shell), [questions](app/src/renderer/questions), [terminal](app/src/renderer/terminal), [main](app/src/main)
