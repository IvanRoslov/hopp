---
kind: leaf
up: [[docs/app/README]]
verified: 2026-11-17 — against the code on main (e9468d7): app/src/main (index.ts, shellEnv.ts, cliInstall.ts), the daemon client and the Makefile
---

# How the app reaches the daemon, and how it is run

The app is a client of the daemon like the CLI; this leaf says how it connects, what it does when no daemon answers, and how it is built and run.

1. The app reads and changes daemon state only through the daemon's API on its Unix socket (`$HOPP_HOME/hopp.sock`, by default `~/.hopp/hopp.sock`), never through the daemon's database, so it sees exactly what the CLI sees.
2. Its lists follow the daemon's event stream; when the stream drops, the app reconnects and asks the daemon to replay what it missed, and every time the stream opens it loads the lists again.
3. When no daemon answers on the socket, the window says so, names the socket, keeps retrying and offers a button that runs `hopp daemon start` (or says it found no `hopp`); an open terminal stays, since tmux does not need the daemon.
4. The app takes `PATH` from the user's login shell, so a daemon it starts finds the same agents a terminal would; a slow shell is waited for (up to 30 seconds) only on the first start, and the `PATH` is remembered and refreshed in the background later. Started with no locale, as from the Dock, it gives itself a UTF-8 one, because tmux draws every non-ASCII character as `_` for a client without one.
5. Only the main process touches the socket and processes; the page runs without Node, isolated and sandboxed, and reaches the main process through a short list of named calls.
6. `make app-install` installs it, `make app-dev` runs it, `make app-pack` builds an unsigned `hopp.app` under `app/dist/`, `make app-install-mac` builds `bin/hopp` and the app and puts the app in `/Applications`, and `make app-test` type-checks it and runs its unit and end-to-end tests against a fake daemon on a temporary socket, never `~/.hopp`.
7. `make app-pack` builds the app for this Mac with its icon, node-pty unpacked from the archive and one instance at a time; it is not signed.

Code: [main](app/src/main), [daemon client](app/src/main/daemon), [packaging script](app/scripts), [repo root](.)
