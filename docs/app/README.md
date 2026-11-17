---
component: app
repo: this repo, `app/` (Electron, React, TypeScript)
last-verified: 2026-11-16
kind: leaf
up: [[INDEX]]
verified: 2026-11-16 — make app-test on shell-page (30ab8ae); facts 7, 9 and 11 rechecked against the page code there
---

# app

The desktop app is a window onto the daemon: it lists the daemon's sessions, opens one in a real terminal, and shows and answers its questions. Its main process also keeps projects, tasks and long-lived agents and launches their sessions: [[docs/app/shell]]; a task with a pipeline, its feed, stages and artifacts: [[docs/app/pipelines]]; what the window shows and how the human works in it: [[docs/app/page]]; repositories picked from GitHub: [[docs/app/github]].

### How it talks to the daemon

1. The app reads and changes daemon state only through the daemon's API on its Unix socket (`$HOPP_HOME/hopp.sock`, by default `~/.hopp/hopp.sock`), never through the daemon's database, so it sees exactly what the CLI sees.
2. The list follows the daemon's event stream; when the stream drops, the app reconnects and asks the daemon to replay what it missed, and every time the stream opens it loads the whole list again.
3. When no daemon answers on the socket, the list's place says so, names the socket, keeps retrying, and offers a button that runs `hopp daemon start` (or says it found no `hopp`); an open terminal stays, since tmux does not need the daemon. The app takes `PATH` from the user's login shell, so a daemon it starts finds the same agents a terminal would.
4. Only the main process touches the socket and processes; the page runs without Node, isolated and sandboxed, and reaches the main process through a short list of named calls.

### The terminal

5. A session's terminal is one more tmux client: the app runs the attach command the daemon returns in a pseudo-terminal, without the `TMUX` variable, so typing in it is typing into the session.
6. Closing a terminal, switching sessions, closing the window or quitting the app hangs up that client, so tmux detaches it and the session keeps running.
7. The terminal changes size only when its own box does (the window, a column opening or closing, or the human dragging a column's width); a question arriving or the list updating never resizes it.
8. While another tmux client of a different size is attached, the window takes tmux's `window-size` rule (by default `latest`: the size of the client that was used last), and the larger client shows dots in the area the window does not cover.
9. When the session ends or the human detaches, the terminal prints one line saying it closed; after a detach a Reattach button opens it again while the session runs, and a session that runs again (Resume, Start) attaches by itself.

### Questions, and running it

10. The header button `Questions · N` counts the selected session's open asks plus one when its screen waits on a question; the column it opens answers both, the screen question through the daemon's quiz answer and asks through the ask answer, and a refused answer shows the daemon's message in place.
11. `make app-install` installs it, `make app-dev` runs it, `make app-pack` builds an unsigned `hopp.app` under `app/dist/`, `make app-install-mac` builds it and puts it in `/Applications`, and `make app-test` type-checks it and runs its unit and end-to-end tests against a fake daemon on a temporary socket, never `~/.hopp`.

Code: [app](app)
