---
last-verified: 2026-11-15
---

# Lessons

Episodic memory: what happened in past runs, distilled into reusable takeaways. Each lesson records a single gotcha, contradiction, or fix that surfaced during a run. Over time they are consolidated into the canonical `docs/` and `docs/playbooks/` docs, keeping the knowledge base accurate without losing traceability.

## Schema

Every lesson file carries this frontmatter (copy [[docs/lessons/_template]]):

```yaml
---
id: <stable-kebab-slug>          # stable record id, also the future retrieval key
date: YYYY-MM-DD
services: ["[[docs/<component>/README]]"]   # related components, or []
source: <PR url / commit SHA / run id>       # traceability to ground truth
status: open | consolidated
consolidated-into: ["[[canonical doc]]"]      # [] while open; filled when distilled
---
```

Body sections: `## What happened` → `## Why / root cause` → `## What to do now` (the reusable takeaway).

## When to write a lesson

After a non-trivial run where: docs/expectation contradicted reality; a root cause was non-obvious; a workaround future runs would repeat; or a decision was made under ambiguity. Not for routine success or already-documented facts. Test: "would another agent, hitting this later, thank you for the note?"

## Lifecycle

Lessons start `status: open`. A lesson updates a fact: its product half becomes a fact in the fact tree (or corrects one), never an appended paragraph, and its process half becomes a rule written once in a playbook ([[docs/playbooks/verify-a-change]], [[docs/playbooks/run-parallel-workers]] or the playbook of the operation) or in [[CLAUDE]], with the lesson linked as its Why. When every half is placed, the lesson is marked `status: consolidated` and `consolidated-into` lists every doc that carries one. A part that no longer holds gets a `note:` in the frontmatter. Consolidated lessons stay as the record, unedited; they are not deleted. To distill open lessons, see [[docs/playbooks/consolidate-lessons]].

Name a lesson file after its takeaway (`a-timeout-is-not-a-failed-delivery.md`), not after the date: the date lives in the frontmatter.

## Map

New lessons are added here as they are written.

| Lesson | Date | Components |
|--------|------|------------|
| [[docs/lessons/_template]] (lesson template) | — | — |
| [[docs/lessons/live-check-the-path-the-old-system-never-took]] | 2026-11-15 | [[docs/daemon/README]] |
| [[docs/lessons/read-ported-behaviour-from-the-code-before-expecting-it]] | 2026-11-15 | [[docs/daemon/README]] |
| [[docs/lessons/check-the-desktop-app-as-the-human-starts-it]] | 2026-11-17 | [[docs/app/README]] |
| [[docs/lessons/claude-code-trusts-a-worktree-through-its-main-repository]] | 2026-11-17 | [[docs/daemon/README]] |
| [[docs/lessons/a-session-id-is-a-name-in-every-tmux-on-the-machine]] | 2026-11-17 | [[docs/daemon/README]], [[docs/app/README]] |
| [[docs/lessons/a-command-that-reads-stdin-refuses-an-empty-body]] | 2026-11-17 | [[docs/daemon/README]] |
| [[docs/lessons/a-freshly-written-executable-starts-slowly-under-load]] | 2026-11-17 | [[docs/app/README]] |
| [[docs/lessons/a-start-text-is-proven-on-live-agents-of-every-harness]] | 2026-11-21 | [[docs/app/README]] |
