---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the code on main (a01bc9a) and the live runs against ~/.hopp
---

# What the daemon is and where it stops

The daemon and its CLI are one program; this leaf says what it owns, what it refuses to know, and why it is a port.

1. The daemon owns the tmux sessions that run agents. It is the first component of the harness, so everything built later sits on top of it.
2. The daemon and its CLI are one program named `hopp`: `hopp daemon run` is the daemon, every other command is a client over its Unix socket, and most commands start the daemon when it is not running. The name differs from rocket on purpose, so rocket keeps working while hopp is developed.
3. hopp keeps its own state in `~/.hopp` (database, socket, pid file, logs), and one daemon serves the whole machine. It shares nothing with rocket at run time except two lock files on harness configs both programs rewrite (`~/.claude.json` and Codex's `config.toml`), which hopp takes under rocket's names so the two never write those files at once.
4. The daemon launches an agent in the folder it is given and knows nothing more about that folder: whoever asks for the session prepares the folder beforehand and cleans it up afterwards. The only git it touches is adding its own files to the folder's git exclude list when the folder happens to be a repository.
5. The daemon has no roles: it does not know the words "orchestrator" or "worker", all sessions are equal, and any session may launch, stop or message any other. Who manages whom is knowledge of the layer above, which also supplies the prompt for each session.
6. A session may carry free-form labels. The daemon stores them, filters lists by them and copies them into every event of the session, and hands a parent's labels to its children at launch, but never acts on them otherwise, so a scenario can mark and find its own sessions.
7. The one relation the daemon keeps is `parent`: which session launched which, to any depth. It lets a session list its children, stops the children before the parent, and gives each agent its own id and its parent's id in the environment; a `hopp run` from inside a session makes that session the parent.
8. A model profile names a harness, a model and an effort; a launch names a profile or a harness, and without either it gets the one default profile, else the configured default harness. The first start seeds three starter profiles.
9. Every lifecycle change of a session, and every step of a message, is appended to an event log in the database; `hopp events` reads it and `hopp events --follow` streams it live.
10. A folder limit on a session (see [[docs/daemon/children]]) keeps an agent from wandering into folders it was not given; it is not a security boundary. The socket has no authentication, and a client that does not send its session id is not limited. The daemon compares folders only: it does not know which repository a folder belongs to.
11. The daemon is ported from rocket, not written from scratch: message delivery and the reading of agent screens carry a long history of debugging against real agent CLIs. `daemon/internal/PORTED.md` records every change made to the ported code.

Code: [daemon](daemon/internal/daemon), [config](daemon/internal/config), [api](daemon/internal/api), [cli](daemon/internal/cli), [store](daemon/internal/store), [agent](daemon/internal/agent)
