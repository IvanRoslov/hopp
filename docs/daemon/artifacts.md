---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on branch daemon-posts and go test ./... (Plan 9)
---

# Artifacts: files kept in immutable versions

An artifact is a named file the daemon keeps a copy of, one immutable version per publish, so what a session produced can be found and read later, exactly as it was, after the source file changed or the session is gone.

### Publishing

1. `hopp artifact publish <file>` copies the file into the daemon as the next version of an artifact and prints `name@version`. The name defaults to the file name without its extension, lowercased, other characters made hyphens; a name is lowercase letters, digits, `.`, `_` and `-`, starts with a letter or digit and has at most 80 characters.
2. Only a regular file is published: a missing file, a directory or a symlink to a directory is refused with its own error code, and nothing is stored. A symlink to a file publishes that file.
3. A file equal (same sha256) to the latest version of that name stores nothing: the publish answers that version and says it is unchanged. Versions count from 1 per scope and name, and two publishes of one name at once get two different, consecutive versions.
4. The stored version is a copy, a copy-on-write clone where the file system can (APFS on macOS), made read-only; changing or deleting the source later does not change it. A version's row and its file appear together or not at all.

### Scope and labels

5. An artifact belongs to a scope: by default the root of the publishing session's tree (its top-most ancestor through `parent`), so every session of a tree shares one set of names. A caller outside a session gives `--scope`; a session may give one too.
6. A version keeps the labels its session had when it was published, overlaid with any `--label` given. Artifacts stay when their sessions are removed; the daemon never removes them.
7. Each new version appends one `artifact.published` event with its id, scope, name, version and labels; an unchanged publish appends none.

### Finding them

8. `hopp artifacts` lists the latest version of each name in the scope (`--scope`, else the root of `$HOPP_SESSION_ID`, else every scope); `--all-versions` lists them all and `--label` narrows them by the labels of the listed versions.
9. `hopp artifact get <name>[@<version>]` prints where the daemon stored that version, the latest when no version is given. Files live under `~/.hopp/artifacts/<scope>/<name>/v<n>/` with the source's file name.

Code: [api](daemon/internal/api), [store](daemon/internal/store), [artifacts](daemon/internal/artifacts), [cli](daemon/internal/cli)
