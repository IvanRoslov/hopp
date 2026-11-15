---
id: live-check-the-path-the-old-system-never-took
date: 2026-11-15
services: ["[[docs/daemon/README]]"]
source: commits 96fc408 and a01bc9a; superpowers/reports/2026-11-15-live-delivery.md (F1)
status: consolidated
consolidated-into: ["[[docs/daemon/messaging]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

The ported message queue passed all of rocket's tests, and every live delivery check passed on sessions launched with a first message. A Claude Code (and a DeepSeek) session launched without one never received any message: each waited silently for 30 minutes and failed `timeout` with attempts 0, with no log line.

## Why / root cause

The Claude Code route pins the recipient's journal before sending, and Claude Code 2.1.325 creates that journal only with the first turn. Rocket almost always launched with a prompt, and the older Claude Code it ran wrote the journal at startup, so its code never met a root without one. Rocket's own data shows the gap latently: 72 messages to its persistent agent failed the same way in the week before a monitor-only fix, which worked only because the journal then existed. In hopp, launching first and messaging later is the ordinary case, so the accident no longer held.

## What to do now

When porting, list the uses the new design makes ordinary but the old flow avoided (here: launching without a first message), and check each one live. A green ported suite proves only the flows the old system used. Product half: messaging fact 9. Process half: the "Check live the flows the old system never took" rule in verify-a-change.
