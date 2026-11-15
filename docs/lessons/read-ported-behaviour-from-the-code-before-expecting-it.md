---
id: read-ported-behaviour-from-the-code-before-expecting-it
date: 2026-11-15
services: ["[[docs/daemon/README]]"]
source: superpowers/reports/2026-11-15-live-delivery.md (F2)
status: consolidated
consolidated-into: ["[[docs/daemon/messaging]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

The plan for the live checks expected a human's unsent draft in Codex to hold a message back, as it does in Kimi Code. In the live run the message was delivered within two seconds and the draft vanished. It looked like a regression of the port.

## Why / root cause

It was not: rocket's draft guard recognises only Claude Code's composer forms (and Kimi Code's), and rocket's own docs say an unknown render, naming Codex, counts as "not busy". hopp's runtime is byte-identical there. The plan's expectation was assumed, not read from the old code or its docs.

## What to do now

Before writing an expectation about ported behaviour into a plan or a test, read it from the old code or the old docs, and quote the line. Product half: messaging fact 6 (a Codex draft is erased). Process half: the "Read a ported behaviour before you expect it" rule in verify-a-change.
