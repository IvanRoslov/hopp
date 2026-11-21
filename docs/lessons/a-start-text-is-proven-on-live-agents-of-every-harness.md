---
id: a-start-text-is-proven-on-live-agents-of-every-harness
date: 2026-11-21
services: ["[[docs/app/README]]"]
source: merge 78e99e8 (orchestrator-keeps-context); tasks prototip-prilozheniya-3, delaem-prototip-nashego-prilozheniya-2 and the three test-delegirovaniya-* tasks of 2026-11-21
status: consolidated
consolidated-into: ["[[docs/app/shell]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

Three tasks ran the same pipeline with the same orchestrator start text. The Codex orchestrator launched 33 workers. The Gemini (pi) and Claude orchestrators launched none: each made every stage itself, and its context filled with the project's files and its own prototypes.

The start text had reached all three whole. Its tests passed: they asserted that the text named the worker profiles and the launch command.

## Why / root cause

The text said to launch workers in one sentence, allowed the orchestrator "its own part", and never said what the orchestrator must not do or why. The pipeline's stages were written as orders to the reader. Two models read that literally and did the stages; one split the work on its own initiative. A test of the text's wording cannot tell these readings apart: only a model's behaviour does.

## What to do now

The start text now says what the orchestrator keeps, what workers do, the reason, and a test for telling them apart; each pipeline stage is a file for workers ([[docs/app/shell]]). The change was accepted only after one small task ran with a Claude, a Gemini and a Codex orchestrator: each launched a worker and a separate checker within two minutes, and its own transcript showed no reading of the project and no writing of the result.

A change to a start text is checked the same way ([[docs/playbooks/verify-a-change]]).
