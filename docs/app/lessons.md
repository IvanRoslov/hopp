---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-25 — facts 1–3 and 6 against the code on branch lessons-are-defect-reports (startText.ts: both lesson commands, no lessons layer, triageLessonsBrief) and make app-test there; facts 4 and 5 against the code on main (670ba12): service.ts (lessonToGuardrails marks the lesson)
---

# Lessons by kind: about hopp, about a project

The daemon stores lessons and their labels without reading them ([[docs/daemon/lessons]]); the app gives the label `hopp.about` a meaning and tells agents what a lesson is: a report of a defect to fix at its source, never something the next agent reads.

1. A lesson labelled `hopp.about=hopp` reports a defect of the harness (its commands, start texts, pipelines, tools, the app); one labelled `hopp.about=project` reports a defect of a project's context: its docs, agent instructions or rules are wrong, outdated or silent about something any task in that repository needs; one without the label is unsorted. The project is the lesson's `hopp.project`, which a lesson takes from the session that wrote it.
2. Every start text spells out both commands (`hopp lesson --label hopp.about=project "…"` and `hopp lesson --label hopp.about=hopp "…"`), asks for one defect per lesson that someone without the writer's context can fix, and says what is not a lesson: what the agent met in the task itself (a site that was hard to open, the subject of the task, a reference or a choice of the human).
3. No start text carries lessons, whatever their kind or state: a lesson reaches the next agent only as the fix it led to (the repository's docs, a tool, hopp itself, or a line in Guardrails), so one agent's note about one task never becomes every later task's context.
4. The human sorts a lesson in the app (about hopp, about a project, unsorted, and which project), which changes its labels in the daemon; an agent does the same with `hopp lessons label`.
5. Add to Guardrails appends a project lesson's text to that project's Guardrails as one bullet that names the lesson, then closes the lesson; doing it again adds nothing.
6. "Triage with a task" starts a task in the project with a ready brief: fix each open lesson's source where the next agent finds it without hopp (the repository's docs, a script or a fix), commit it, close the lesson, relabel a lesson that is really about hopp, close one that is wrong or only a note about one task, and report what was done with each.

Code: [shell](app/src/main/shell), [daemon client](app/src/main/daemon)
