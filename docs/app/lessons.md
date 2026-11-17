---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — against the code on main (670ba12): startText.ts (LESSONS_MAX 20, LESSONS_MAX_BYTES 4096, both lesson commands, triageLessonsBrief), service.ts (lessonToGuardrails marks the lesson)
---

# Lessons by kind: about hopp, about a project

The daemon stores lessons and their labels without reading them ([[docs/daemon/lessons]]); the app gives the label `hopp.about` a meaning and brings a project's lessons back to the agents that work on it.

1. A lesson labelled `hopp.about=hopp` is about the harness (its commands, start texts, pipelines, tools, the app); one labelled `hopp.about=project` is knowledge about a project's repositories, environments or commands that the next task there needs too; one without the label is unsorted. The project is the lesson's `hopp.project`, which a lesson takes from the session that wrote it.
2. Every start text spells out both commands (`hopp lesson --label hopp.about=project "…"` and `hopp lesson --label hopp.about=hopp "…"`) and asks for one fact per lesson that someone without the writer's context can act on.
3. An orchestrator's and its workers' start texts carry the open project lessons of their project, newest first, each with its id, at most 20 and about 4 KB (the rest counted, with the command that lists them all). Closed lessons, lessons about hopp, unsorted ones and other projects' lessons are left out, and the agent is told to close a lesson its work made obsolete, and not one it only read.
4. The human sorts a lesson in the app (about hopp, about a project, unsorted, and which project), which changes its labels in the daemon; an agent does the same with `hopp lessons label`.
5. Add to Guardrails appends a project lesson's text to that project's Guardrails as one bullet that names the lesson, then closes the lesson; doing it again adds nothing.
6. "Triage with a task" starts a task in the project with a ready brief: put each open lesson's knowledge where the next agent finds it without hopp (the repository's docs, a script or a fix), commit it, close the lesson, relabel a lesson that is really about hopp, and report what was done with each.

Code: [shell](app/src/main/shell), [daemon client](app/src/main/daemon)
