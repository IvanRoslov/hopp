---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on branch daemon-posts and go test ./... (Plan 9)
---

# Posts: notes that wait for no answer

A post is a note a session leaves for the human, or the human's own note, that asks for nothing back. It is stored so a client can show it later, after the session that wrote it is gone.

1. `hopp post "<text>"` stores a post and prints its id; the text may also come from `-f <file>` or from stdin. It is from `$HOPP_SESSION_ID` unless `--from` names another session, and `--from ""` makes it the human's own note; an unknown session is refused.
2. A post keeps the labels its session had when it was written, overlaid with any `--label` given, and it stays after `hopp rm` removes that session, so it can still be found by those labels.
3. `--attach` adds file paths, URLs or artifact references (`name@version`, see [[docs/daemon/artifacts]]) to a post. They are stored exactly as given; the daemon does not open or check them.
4. The daemon only stores and lists posts. A new post appends one `post.added` event that carries the post's own labels, so a subscriber can pick out the human's posts too, which have no session.
5. `hopp posts` lists posts oldest first, at most 200 unless `--limit` says otherwise; `--label` and `--from` narrow it. `--after <id>` returns only newer posts, and because ids grow in the order posts are stored, paging with the last id seen never skips a post written meanwhile.

Code: [api](daemon/internal/api), [store](daemon/internal/store), [cli](daemon/internal/cli)
