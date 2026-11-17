---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — against the code on main (e9468d7): Side, NewTask, ProjectForm, Settings, Models, Lessons; make app-test there
---

# The window

What the human sees in the app's window around the work: the left column, the forms and Settings. A task's or an agent's own screen: [[docs/app/workview]]; what the main process keeps and launches behind it: [[docs/app/shell]].

### The left column

1. Top to bottom: New task and Pipelines; "Waiting for you", one row per open question (its text as plain words, markdown marks removed) with the task or agent under it; "Work", the active tasks grouped by project (only projects that have some), each once with its state; "Recent", the finished tasks; and pinned at the bottom the long-lived agents, New agent, Settings and the theme switch.
2. A task's state is a mark when it works (a ring with a dot) or idles (an empty ring), and a word on a second line otherwise: waiting for me, starting, stopped, agent exited, error or session gone. A task the daemon does not list yet reads as starting for its first two minutes.
3. A "Waiting for you" row finds its task through the asking session (the task's own, or one whose labels or parents lead to it), never through the ask's labels, since the daemon does not copy a session's labels into its asks.
4. With no project the window shows only "Create your first project"; with projects but no tasks the column says so.

### Forms

5. New task offers only enabled model profiles and follows changes to them, remembers the last project and profiles (and says so when a remembered one is now switched off), starts with "No pipeline" every time, shows a chosen pipeline's stages before launch (a long stage text folded to three lines with Show all), and starts with ⌘↩ or the arrow button. Every form shows an error next to the field it names and ignores a second submit while the first runs.
6. The project form fills the slug from the name until the human edits it, keeps the orchestrator's repository among the main fields, and opens "Advanced" by itself when an error belongs there. A repository comes from GitHub (a search over the human's repositories through their own gh, or why gh is not usable and the command that fixes it; a pick is cloned in place while Save waits) or from a folder; a managed clone reads `owner/repo` with the GitHub mark wherever a repository is shown, with the full path in its tooltip.

### Settings and looks

7. Settings has four tabs: Projects (edit, add), Models, Tools (the preferences text with its save time, each tool with an on/off switch, a paid mark, its USAGE on click, broken tools by name) and Lessons.
8. Models lists every profile of the daemon, on first then off, each with a switch, its harness and its effort as tags (`effort: default` only where its model has levels) and the default marked, with Add model, Copy…, Import models and in-place editing (see [[docs/app/models]]); the New task and New agent pickers show the same effort tag.
9. Lessons shows the open lessons by default (closed ones on a switch) in three groups, about hopp, about each project and unsorted, each lesson with its `#id`, its text as markdown, its author, task and age, and Close, Move to…, Add to Guardrails and Copy text (see [[docs/app/lessons]]). The open count shows on the tab, beside Settings in the left column and on a project's page.
10. The look is the accepted prototype's, in English, dark or light: the theme follows the system until the human picks one, then stays. Artifact files that do not load show a placeholder, never a broken image; an SVG or a picture smaller than its tile is shown whole, not cropped.

Code: [renderer](app/src/renderer)
