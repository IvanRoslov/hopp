---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-16 — make app-test on shell-page (30ab8ae), the visual walks at 1280, 1440 and 1920 in both themes, and the packaged app against a fake daemon
---

# The window

What the human sees and does in the app's window. What the main process keeps and launches behind it: [[docs/app/shell]]; a task with a pipeline: [[docs/app/pipelines]].

### The left column

1. Top to bottom: New task and Pipelines; "Waiting for you", one row per open question (its text as plain words, markdown marks removed) with the task or agent under it; "Work", the active tasks grouped by project (only projects that have some), each once with its state; "Recent", the finished tasks; and pinned at the bottom the long-lived agents, New agent, Settings and the theme switch.
2. A task's state is a mark when it works (a ring with a dot) or idles (an empty ring), and a word on a second line otherwise: waiting for me, starting, stopped, agent exited, error or session gone. A task the daemon does not list yet reads as starting for its first two minutes.
3. A "Waiting for you" row finds its task through the asking session (the task's own, or one whose labels or parents lead to it), never through the ask's labels, since the daemon does not copy a session's labels into its asks.
4. With no project the window shows only "Create your first project"; with projects but no tasks the column says so.

### Forms

5. New task offers only enabled model profiles and follows changes to them, remembers the last project and profiles (and says so when a remembered one is now switched off), starts with "No pipeline" every time, shows a chosen pipeline's stages before launch (a long stage text folded to three lines with Show all), and starts with ⌘↩ or the arrow button. Every form shows an error next to the field it names and ignores a second submit while the first runs.
6. The project form fills the slug from the name until the human edits it, keeps the orchestrator's repository among the main fields, and opens "Advanced" by itself when an error belongs there. A repository comes from GitHub (a search over the human's repositories through their own gh, or why gh is not usable and the command that fixes it; a pick is cloned in place while Save waits) or from a folder; a managed clone reads `owner/repo` with the GitHub mark wherever a repository is shown, with the full path in its tooltip.

### A task, an agent

7. A task without a pipeline has one header row: its title (cut with an ellipsis), Stop (which names the number of child sessions and asks first) or Resume, `Questions · N` for the selected session, the session picker naming each session's state, a quiet status cut with its whole text in the tooltip, and the `···` menu (Finish; Remove from list, once the orchestrator's session no longer runs; Task details); the terminal starts right under it, and with a column open the picker moves to the terminal's head. An error, or the warning that the clone could not be fetched first (with the reason, until dismissed for that task), takes a second header line only while it is there; a pipeline task's header has the title, Stop or Resume, Stages, Artifacts, Terminal and the menu. A terminal the human detached offers Reattach; a session that runs again after Resume attaches by itself. Task details say what the worktree started from (`origin/main · 9d10cd1 · 5 minutes ago`, or `HEAD (<branch>)` for a folder).
8. A long-lived agent has the same header: Start when it is off, with "Off" and the number of letters waiting for it as its status, and Stop (asking first) when it runs; Rename and Remove agent are in the `···` menu while it is off. A Start refused for a tmux session outside hopp offers Rename (in Agent details) and Remove agent beside the reason, and a rename with letters waiting says first that they stay under the old name.
9. The questions (or details) column and the left column can be dragged to new widths, or moved with the arrow keys, and the widths are remembered; the terminal resizes only on that drag or when a column opens or closes.

### Settings and looks

10. Settings has Projects (edit, add), Models (every profile of the daemon, on first then off, each with a switch, its harness as a tag and the default marked; in place: edit the description and the effort its harness offers, make default, move, remove, and Import models, which adds a switched-off profile for each new current model and lists the harnesses it could not read), Tools (the preferences text with its save time, each tool with an on/off switch, a paid mark, its USAGE on click, broken tools by name) and Lessons (new or all, mark as done).
11. The look is the accepted prototype's, in English, dark or light: the theme follows the system until the human picks one, then stays. Artifact files that do not load show a placeholder, never a broken image; an SVG or a picture smaller than its tile is shown whole, not cropped.
12. `make app-pack` builds an unsigned `hopp.app` for this Mac under `app/dist/`, with the app icon, node-pty unpacked from the archive and one instance at a time; it is not signed or installed anywhere.

Code: [renderer](app/src/renderer), [packaging script](app/scripts)
