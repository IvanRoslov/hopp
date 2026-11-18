---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-18 — fact 1 against the code on main (a2c307c) on branch session-id-100; fact 8 against the code on main (be30b99) and a live codex-cli 0.166.0 run; the rest 2026-11-15 against main (1ddc9bd) and the live runs of all five harnesses against ~/.hopp
---

# Sessions: launch, stop, restore, reconcile, remove

A session is one tmux session running one agent in one folder. This leaf says how its life goes and which rules keep hopp off other people's tmux sessions.

1. A launch takes an absolute path to an existing folder and either an id (a-z, 0-9 and dashes, at most 100 characters) or none; without one, the id is made from the folder's name, cut to 40 characters, and gets `-2`, `-3`, … until it is free. A bad folder or a taken id refuses the launch before anything is recorded.
2. The tmux session name equals the session id. The ported Claude Code delivery code finds an agent's pane by its session id, so a separate tmux name would mean editing the most carefully debugged code.
3. An id counts as taken when hopp's own store has it in any state or a live tmux session already uses it, so hopp never picks the name of a rocket or human session and never adopts a tmux session it finds. An ended session's record keeps its id taken until `hopp rm` removes it; then the id can be used again. `GET /v1/session-ids/<id>` answers, without launching anything, whether an id is taken and whether a hopp session or a tmux session holds it.
4. Before destroying a tmux session, hopp checks that the session's tmux environment carries the hopp session id. A tmux session that fails the check is left running, and the hopp session becomes `errored` with reason `tmux_not_owned`.
5. Stopping a session stops its live descendants first, deepest first, and ends each one `killed` (or `done` when asked). A session that already ended is left as it is.
6. Restore relaunches a `killed` or `errored` session, or a `running` one whose tmux is gone or holds only a bare shell, in the same folder from the stored snapshot (harness, model, effort, system prompt, environment) and without a first message. A session whose agent still looks alive is relaunched only with `--force`.
7. Stopping or restarting the daemon never stops a session. On start the daemon reconciles: a session whose tmux is gone becomes `errored` (`tmux_missing`), and one whose folder is gone becomes `errored` (`dir_missing`) with its tmux left alone.
8. A launch may pass extra environment, but the variables the daemon sets for the agent (its id, its parent's id, the socket and the state directory) always win over it. Codex runs the agent's commands in a plain shell with that environment, not in a login shell, which rereads the user's profile on every command (about 20 seconds each on the author's machine with codex-cli 0.166.0). It may also pass a permission mode: Claude Code and DeepSeek skip permission prompts unless the mode is another of Claude Code's modes (such as `manual` or `plan`), a mode Claude Code does not accept refuses the launch with the accepted list, and the other harnesses ignore it and always run with their prompts approved. A Claude Code session in `manual` mode still takes hopp's messages over its socket without holding them for approval (live check of 2026-11-15).
9. A launch writes into the folder only what the harness needs to start: a launch script for every harness; for Claude Code and DeepSeek the hook scripts under `.hopp/`, `.claude/settings.local.json` and the system prompt file; for Codex, Kimi Code and Pi the system prompt in `AGENTS.md` between `hopp` markers, which leaves a block rocket wrote there alone. Running a hopp session and a rocket session in the same folder at once is not supported. For Claude Code a launch also marks the folder, and the root of the main repository it belongs to, as trusted in `~/.claude.json`: Claude Code 2.1.326 keeps the trust of a worktree whose project settings pre-approve permissions under the main repository and otherwise stops on its trust screen (reproduced 2026-11-17).

### Removing a session

10. `hopp rm <id>` removes only an ended session: a live one is refused (`session_live`), one with descendants needs `--recursive` and then every descendant must have ended too (`session_has_children`), and a session that still has a message to it queued, delivering or accepted is refused (`session_delivery_pending`). `hopp rm --ended` removes every ended session at once.
11. Removal deletes, in one step, hopp's own record of the session: the session, the messages to it, its events, its token usage and its asks. Messages it sent to sessions that remain are kept, and nothing outside hopp's database (the folder, the agent's journals, the tmux session) is touched.
12. With Pi, an id launched again in the same folder continues the old conversation, because Pi keys its journal by that id; for a fresh start use another id or another folder.

Code: [session](daemon/internal/session), [runtime](daemon/internal/runtime), [agent](daemon/internal/agent), [store](daemon/internal/store), [cli](daemon/internal/cli)
