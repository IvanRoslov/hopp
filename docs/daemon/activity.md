---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the code on main (a01bc9a) and the live checks of 2026-11-15 against ~/.hopp
---

# Activity, alerts to a parent, and the event stream

The daemon watches what each agent is doing, tells a parent when a child needs help, and lets clients follow everything live.

1. Each running session has an activity: `active`, `ready`, `idle`, `waiting_input`, `blocked` or `exited`; it starts empty and is filled by the first sweep. Delivery reads it to decide when a recipient can take a message.
2. The daemon sweeps every session every `activity_poll_interval` (5 seconds). Claude Code and DeepSeek activity is read from the exact journal of the launched process; the other harnesses are read through their adapter, so a turn shorter than one sweep can pass unseen.
3. A session `ready` for longer than `ready_to_idle` (5 minutes) becomes `idle`. A Claude Code process that has no journal yet counts as `ready` when Claude Code's own registry says it is idle.
4. A session whose pane lost its agent (only a bare shell is left, or the tmux session is gone) shows `exited` while its state stays `running`; `hopp restore` relaunches it.
5. When Codex or Kimi Code stops on a start screen before its first turn, or a Claude Code permission dialog is open, the session's question is recorded and the session waits; hopp never presses keys, and the question is answered in the session's terminal.
6. A child stuck on a start screen, or whose turn failed (for example a Kimi quota error), is reported once: as a `[hopp]` system message to its parent when the parent is running, else as a `session.alert` event.
7. Every `heartbeat_interval` (5 minutes) a running session with stalled children gets one `[hopp] Session <id> status:` message naming them, unless it is busy itself. A child is stalled when it is `exited`, or `idle`, `blocked` or `waiting_input` for longer than `child_stall_threshold` (15 minutes).
8. A child that has ended (`done`, `killed` or `errored`) is never named in that summary, so a parent is not told when the reconcile at daemon start marks a child `errored`.
9. Every change is appended to the event log with the session's labels in its data. `hopp events --follow` streams it live from `/v1/events/stream` and can be narrowed by `--session` and `--label`; it exits cleanly on Ctrl-C and when the daemon stops.

Code: [monitor](daemon/internal/monitor), [heartbeat](daemon/internal/heartbeat), [activity](daemon/internal/activity), [bus](daemon/internal/bus), [api](daemon/internal/api), [cli](daemon/internal/cli)
