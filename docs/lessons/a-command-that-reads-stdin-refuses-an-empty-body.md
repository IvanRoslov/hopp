---
id: a-command-that-reads-stdin-refuses-an-empty-body
date: 2026-11-17
services: ["[[docs/daemon/README]]"]
source: commit 6a93e8a; hopp lesson #3
status: consolidated
consolidated-into: ["[[docs/daemon/messaging]]", "[[docs/daemon/posts]]", "[[docs/daemon/lessons]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

A worker twice sent its report with `hopp send --file -`, and the orchestrator received "-" and "x": the text from stdin was lost, and nothing told the worker (hopp lesson #3).

## Why / root cause

The command sent whatever arrived, including nothing: a heredoc the agent's shell did not pass on, or a terminal on stdin, gave an empty or meaningless body that went out as a message.

## What to do now

A command that takes its text from an argument, a file or stdin takes it from exactly one source and refuses an empty pipe, a terminal on stdin and a blank text, with a hint to write the text to a file. Product half: [[docs/daemon/messaging]] fact 7, and the same rule for `hopp post` ([[docs/daemon/posts]] fact 1) and `hopp lesson` ([[docs/daemon/lessons]] fact 1). Process half: the "Refuse empty input where it enters" rule in [[docs/playbooks/verify-a-change]].
