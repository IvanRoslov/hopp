---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on main and go test ./... (Plan 5); the text sources by go test on lessons-1; labels and events by go test on lessons-kinds
---

# Lessons recorded through the daemon

A lesson is a note from an agent or the human about what would make the harness better. It is stored by the daemon so it is not lost when the session that wrote it ends; turning it into a change is someone else's work.

1. `hopp lesson "<text>"` stores a lesson and prints its id; the text may also come from `-f <file>` or from stdin (`-` as the text, `-f -`, or a pipe with no text given), so a long note with backticks and `$` survives the shell; an empty or blank text is refused. Inside a session the lesson names that session; from the human it names none.
2. The daemon only stores and lists lessons and changes their labels. It never reads, routes or acts on their text or labels; it appends a `lesson.added`, `lesson.closed` or `lesson.labeled` event, so a client can follow them live.
3. A lesson keeps the labels its session had when it was written, overlaid with any `--label` given, and it stays after `hopp rm` removes that session, so a lesson can still be found by the labels of a tree of sessions that is gone.
4. `hopp lessons` lists the new ones, oldest first, one line each (`--full`: whole, with their labels); `--all` or `--closed`, `--label` and `--from` narrow it. `hopp lessons close <id>...` marks lessons handled, and closing one twice changes nothing.
5. `hopp lessons label <id> k=v...` sets labels on a lesson and `k=` removes one, so whoever sorts lessons (an agent or the human) can move one between kinds; any session may do it.
6. These stored lessons are not the files under [[docs/lessons/README]]: those are this repository's own episodic memory, written by whoever works on hopp.

Code: [api](daemon/internal/api), [store](daemon/internal/store), [cli](daemon/internal/cli)
