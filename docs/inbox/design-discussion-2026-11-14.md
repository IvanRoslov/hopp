---
last-verified: 2026-11-14
---

# hopp design discussion, 14 November 2026

Notes from the first discussion. Statements are marked by source: said by Ivan, read in the old rocket code, or proposed by Claude and not approved. Triage each into the tree once it is settled.

## Why a new version (said by Ivan)

- The old rocket (`~/projects/rocket`) has too much baked in for specific scenarios.
- The goal is a more universal solution. There may be many scenarios, and they will differ by task.
- Creative was added as a separate part and still blurred everything.
- The part worth taking from rocket and improving is the daemon that manages tmux sessions and delivers messages between them.
- Launching different models and different harnesses must stay possible.

## Decided (said by Ivan)

- hopp is a harness. Its first component is the daemon, which manages tmux sessions and lets agents talk to each other.
- The daemon and the CLI are one program named `hopp`, so the old rocket is not broken while hopp is developed.
- The daemon only needs to know "a tmux session in such-and-such folder". It does not need a repository or a worktree. Ivan's wording was "I think that is enough".
- Everything is hopp's own: state directory `~/.hopp`, socket, database and tmux session names. The exact tmux naming scheme is not chosen yet.
- Docs and code live in one repository. Docs are written in English.

## Read in the old rocket

- rocket is one binary: `rocket daemon run` starts the daemon, every other command is a client over a Unix socket.
- Packages `runtime`, `socketmsg` and `nativeinput` import nothing else from the project; `claudeinstance` imports only `socketmsg`. They can be carried over as they are.
- `queue`, `monitor` and `session` depend on one shared `store` package that holds sessions, messages, tasks, question threads, creative, devices and token usage side by side (34 migrations).
- The session manager has creative branches in spawn and restore. The agent launch spec carries role, parent, project, repository, feature and a `Creative` flag.
- The sessions table has columns of the development scenario: `task_id`, `subtask_id`, PR and CI fields.
- Three delivery transports: the Claude Code socket, a dedicated socket channel for Pi, and tmux paste as the fallback.
- Five harness adapters: `claude-code`, `codex`, `kimi-code`, `pi`, `deepseek`. `deepseek` is Claude Code with the API address, key and model replaced through the environment.
- A model profile is a name, harness, model, effort, description, enabled flag and position. A session stores a snapshot of its profile, and restore relaunches from the snapshot.
- The profile selection policy is written in terms of orchestrator, worker and task.

## Proposed by Claude, not approved

- The daemon does not know the words "orchestrator", "worker", "task" or "creative". A scenario passes the folder, profile, system prompt, first message, environment and free-form labels when it launches a session; the daemon stores and returns the labels but does not read them.
- A scenario subscribes to daemon events and keeps its own state in its own database.
- Split harness and provider in the profile, so that "Claude Code + DeepSeek" is a registry row and not a separate adapter.
- Keep the profile selection policy out of the daemon: the layer above decides who may use which profile.

## Open questions

- Must sessions from different scenarios see each other and exchange messages? The answer decides between one shared daemon per machine and a core library that every scenario carries. Claude recommends one shared daemon.
- Implementation language: rocket is written in Go; the language for hopp was not discussed.
