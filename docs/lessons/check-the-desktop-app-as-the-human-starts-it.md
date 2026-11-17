---
id: check-the-desktop-app-as-the-human-starts-it
date: 2026-11-17
services: ["[[docs/app/README]]"]
source: commits bafd4fc and 27cb44f
status: consolidated
consolidated-into: ["[[docs/app/connection]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

Every live check of the app had been run from a terminal, and all of them passed. Started from the Dock, the same app showed underscores in place of the harness logo, the prompt mark and typed Cyrillic, and a daemon it started could not find `claude`.

## Why / root cause

A Dock or Finder launch gets no `LANG` and the short GUI `PATH`, while a launch from a shell inherits both. tmux treats a client without a UTF-8 locale as not UTF-8 and draws non-ASCII as `_`. The login shell that would give the full `PATH` took over 3 seconds, the app gave up after 3, so the daemon started with the short one.

## What to do now

Include one launch of the packed app from Finder or `open` in every live check of the desktop app; a launch from a shell hides what its environment provides. Product half: [[docs/app/connection]] fact 4 (the app gives itself a UTF-8 locale and waits up to 30 seconds for the login shell's `PATH`, remembered after). Process half: the "Live-check the desktop app the way the human starts it" rule in [[docs/playbooks/verify-a-change]].
