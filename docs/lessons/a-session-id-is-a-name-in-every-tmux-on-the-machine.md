---
id: a-session-id-is-a-name-in-every-tmux-on-the-machine
date: 2026-11-17
services: ["[[docs/daemon/README]]", "[[docs/app/README]]"]
source: commit 467e4c0; the human's report of the agent cto
status: consolidated
consolidated-into: ["[[docs/daemon/sessions]]", "[[docs/app/agents]]", "[[docs/playbooks/verify-a-change]]"]
---

## What happened

The human created a long-lived agent named `cto`. Start answered "session id is taken: cto", and the app offered no way out: the name was stored, and Remove was hidden in a menu.

## Why / root cause

A hopp session id is also its tmux session name, and tmux names are shared by every tmux user on the machine. A live rocket session was called `cto`. The daemon rightly refuses an id a tmux session outside hopp holds, but the app checked only its own store when it accepted the name, so the refusal came at Start, in the daemon's words.

## What to do now

A name hopp hands to another system lives in that system's namespace: check every place it lands (tmux sessions, mailboxes, folders, branches) when the name is accepted, and say the reason next to the name. Product half: [[docs/daemon/sessions]] fact 3 (an id is taken by a live tmux session too, and `GET /v1/session-ids/<id>` says by what) and [[docs/app/agents]] fact 4 (creating or renaming refuses such a name). Process half: the "A name you hand to another system lives in its namespace" rule in [[docs/playbooks/verify-a-change]].
