---
kind: leaf
up: [[docs/app/shell]]
verified: 2026-11-16 — make app-test on shell-main, including a run against the real daemon on a temp HOPP_HOME; facts 6 and 7 by make app-test and e2e/ask-dismiss.spec.ts on ask-dismiss
---

# Pipelines, the feed, stages and artifacts

A task may follow a pipeline: an ordered list of stages the orchestrator walks while the human watches the task's feed and accepts stages. The daemon knows none of these words; the app builds them from the daemon's posts, asks and artifacts and the labels on them.

1. Pipelines are kept by the app in its store, next to projects. Each stage has a name, what it does, what its result looks like, whether it may have substages and whether it waits for approval, and an id that survives renames and moves. Three starter pipelines (Development, Landing page, Promo video) are added once to a store that has none; removed, they do not come back.
2. Launching a task with a pipeline copies the pipeline into the task, so later edits do not touch running tasks, and adds a pipeline layer to the orchestrator's start text: the stages in order and the exact `hopp post`, `hopp artifact publish` and `hopp ask` commands with their labels.
3. The labels are the contract between that text and the app: `hopp.stage` on everything of a stage, `hopp.substage` and `hopp.substage_title` on everything of a substage (the first title seen names it, so a post carrying only the slug still shows the title), `hopp.event=stage_started` or `stage_done` on a post, `hopp.kind=submission` on the ask that submits a stage and `hopp.kind=paid` on a paid-consent ask. `hopp.project` and `hopp.task` come from the session.
4. A task's feed is the daemon's posts labelled with its `hopp.task`, the asks (open and closed) that carry that label or come from one of the task's sessions, and every version of the artifacts whose scope is the orchestrator's session. The page is told to reload a task's feed when a daemon event carries that task's label.
5. A stage's state (not started, started, submitted, accepted, returned) is derived by the app from those labels; a stage that does not wait for approval is accepted when the next stage starts or a `stage_done` post says so.
6. The human's line in the feed is sent to the orchestrator as a message and recorded as a post without a sender, with the task's labels; it is refused while the orchestrator is not running. While exactly one ordinary question of the task is open, the line goes as that question's answer instead, unless the human unticks "Send as the answer to". Once the message is sent, a failure to record the post is logged, not reported, so the line is never sent twice.
7. A submission is answered Accept, or Return with the text of what to fix, which becomes the ask's answer. Any open ask in the feed can also be closed as "Not relevant" after a one-line confirmation, which leaves a quiet "Dismissed · not relevant" line; a dismissed submission puts its stage back to started, never to accepted.
8. The page loads artifact files from `hopp-artifact://v/<id>`, which serves only files inside `$HOPP_HOME/artifacts` (after resolving symlinks) under a sandboxing content policy, so an HTML artifact shows without running scripts or loading files beside it. The text viewer reads at most 2 MB. A markdown artifact (by type or `.md` name), the feed's posts, questions and answers, and the stage texts show as formatted markdown (GFM tables and task lists; a Source switch in the viewer, for both sides of a comparison): raw HTML in them shows as text, a link opens in the browser only for https or opens another artifact of the task when it names one (`name@version`, a file name), and images load only from artifacts or `data:`.

Code: [shell](app/src/main/shell), [shared](app/src/shared)
