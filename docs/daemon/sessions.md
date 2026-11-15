---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the code on main and a live run of all five harnesses against ~/.hopp
---

# Sessions: launch, stop, restore, reconcile

A session is one tmux session running one agent in one folder. This leaf says how its life goes and which rules keep hopp off other people's tmux sessions.

1. A launch takes an absolute path to an existing folder and either an id or none; without one, the id is made from the folder's name and gets `-2`, `-3`, … until it is free. A bad folder or a taken id refuses the launch before anything is recorded.
2. The tmux session name equals the session id. The ported Claude Code delivery code finds an agent's pane by its session id, so a separate tmux name would mean editing the most carefully debugged code.
3. An id counts as taken when hopp's own store has it in any state or a live tmux session already uses it, so hopp never picks the name of a rocket or human session and never adopts a tmux session it finds.
4. Before destroying a tmux session, hopp checks that the session's tmux environment carries the hopp session id. A tmux session that fails the check is left running, and the hopp session becomes `errored` with reason `tmux_not_owned`.
5. Stopping a session stops its live descendants first, deepest first, and ends each one `killed` (or `done` when asked). A session that already ended is left as it is.
6. Restore relaunches a `killed` or `errored` session, or a `running` one whose tmux is gone or holds only a bare shell, in the same folder from the stored snapshot (harness, model, effort, system prompt, environment) and without a first message. A session whose agent still looks alive is relaunched only with `--force`.
7. Stopping or restarting the daemon never stops a session. On start the daemon reconciles: a session whose tmux is gone becomes `errored` (`tmux_missing`), and one whose folder is gone becomes `errored` (`dir_missing`) with its tmux left alone.
8. A launch may pass extra environment, but the variables the daemon sets for the agent (its id, its parent's id, the socket and the state directory) always win over it.
9. A launch writes into the folder only what the harness needs to start: a launch script for every harness; for Claude Code and DeepSeek the hook scripts under `.hopp/`, `.claude/settings.local.json` and the system prompt file; for Codex, Kimi Code and Pi the system prompt in `AGENTS.md` between `hopp` markers, which leaves a block rocket wrote there alone. Running a hopp session and a rocket session in the same folder at once is not supported.

Code: [session](internal/session), [runtime](internal/runtime), [agent](internal/agent)
