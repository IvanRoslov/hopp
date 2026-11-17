---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-16 — make app-test on shell-page (30ab8ae), the visual walks at 1280, 1440 and 1920 in both themes, and the packaged app against a fake daemon
---

# The window

What the human sees and does in the app's window. What the main process keeps and launches behind it: [[docs/app/shell]]; a task with a pipeline: [[docs/app/pipelines]].

### The left column

1. Top to bottom: New task and Pipelines; "Waiting for you", one row per open question with the task or agent under it; "Work", the active tasks grouped by project (only projects that have some), each once with its state; "Recent", the finished tasks; and pinned at the bottom the long-lived agents, New agent, Settings and the theme switch.
2. A task's state is a mark when it works (a ring with a dot) or idles (an empty ring), and a word on a second line otherwise: waiting for me, starting, stopped, agent exited, error or session gone. A task the daemon does not list yet reads as starting for its first two minutes.
3. A "Waiting for you" row finds its task through the asking session (the task's own, or one whose labels or parents lead to it), never through the ask's labels, since the daemon does not copy a session's labels into its asks.
4. With no project the window shows only "Create your first project"; with projects but no tasks the column says so.

### Forms

5. New task offers only enabled model profiles, remembers the last project and profiles, starts with "No pipeline" every time, shows a chosen pipeline's stages before launch (a long stage text folded to three lines with Show all), and starts with ⌘↩ or the arrow button. Every form shows an error next to the field it names and ignores a second submit while the first runs.
6. The project form fills the slug from the name until the human edits it, keeps the orchestrator's repository among the main fields, and opens "Advanced" by itself when an error belongs there. A repository comes from GitHub (a search over the human's repositories through their own gh, or why gh is not usable and the command that fixes it; a pick is cloned in place while Save waits) or from a folder; a managed clone reads `owner/repo` with the GitHub mark wherever a repository is shown, with the full path in its tooltip.

### A task, an agent

7. A task without a pipeline has a header with its title, `Questions · N` for the selected session and the `···` menu (Stop, which names the number of child sessions and asks first; Resume; Finish; Remove from list, offered once the orchestrator's session no longer runs; Task details), a session picker that names each session's state, and the terminal of the chosen session. A terminal the human detached offers Reattach; a session that runs again after Resume attaches by itself.
8. A long-lived agent that is off says so with the number of letters waiting for it and a Start button; running, it has the same terminal and questions as a task.
9. The questions (or details) column and the left column can be dragged to new widths, or moved with the arrow keys, and the widths are remembered; the terminal resizes only on that drag or when a column opens or closes.

### Settings and looks

10. Settings has Projects (edit, add), Models (the daemon's profiles, read only), Tools (the preferences text with its save time, each tool with an on/off switch, a paid mark, its USAGE on click, broken tools by name) and Lessons (new or all, mark as done).
11. The look is the accepted prototype's, in English, dark or light: the theme follows the system until the human picks one, then stays. Artifact files that do not load show a placeholder, never a broken image; an SVG or a picture smaller than its tile is shown whole, not cropped.
12. `make app-pack` builds an unsigned `hopp.app` for this Mac under `app/dist/`, with the app icon, node-pty unpacked from the archive and one instance at a time; it is not signed or installed anywhere.

Code: [renderer](app/src/renderer), [packaging script](app/scripts)
