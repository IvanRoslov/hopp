---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the code on main (a01bc9a) and the live checks of 2026-11-15 on all five harnesses against ~/.hopp
---

# Messages between sessions

A message goes from a session, a human or the daemon to one live session. This leaf says how it travels, what holds it back and what the sender learns.

1. `hopp send` stores the message and returns at once; delivery runs in the background, one message at a time per recipient and in order, and `--wait` follows the message until it is delivered or failed (exit 1). A message to an id that does not exist is refused with 404, and one to a session that has ended with 409, unless a mailbox of that name is registered (`hopp mailbox add`): then it waits there until a session of that id reads it with `hopp inbox next`.
2. Inside a session the sender is that session (`HOPP_SESSION_ID`), and the recipient sees `[from <id>]` before the text; a message from a plain terminal or from the daemon carries no sender. When a message from a live session fails, the sender gets a `[hopp] delivery FAILED` notice.
3. Each harness has one transport: Claude Code and DeepSeek get the message through Claude Code's own session socket, Pi through its socket channel, and Codex and Kimi Code have it typed into their tmux pane. A message on the Claude Code socket route never falls back to typing.
4. The socket route delivers only to the exact Claude Code process hopp launched in that pane (its registry entry, pane and process ancestry must match), so a Claude Code started by a human or by rocket in the same folder never receives a hopp message.
5. A message counts as `delivered` only when the recipient's own journal shows it arrived; `accepted` means the agent has the text and that proof is still awaited. A message that may have been written is never written again, even across a daemon restart: without proof by its deadline it fails `delivery_unconfirmed`.
6. Typing into a pane waits while the composer holds a human's unsent text that hopp recognises, and Kimi Code's draft is never overwritten. The check knows only Claude Code's and Kimi Code's composers, so a draft typed in Codex is erased when a message is delivered there (inherited from rocket).
7. A message longer than `large_message_threshold` (2048 bytes) or 20 lines is written to `<dir>/.hopp/inbox/msg-<id>.md`, and the agent gets a short pointer to that file instead of the text.
8. A message still queued after `queue_timeout` (30 minutes) fails with reason `timeout`.
9. A Claude Code or DeepSeek session launched without a first message has no journal until its first turn; hopp still delivers to it and proves delivery from the journal that first turn creates at the path Claude Code's registry names.
10. While a message waits on the Claude Code route, the reason is written on the message (`hopp messages` shows `queued (<reason>)`, `hopp send --wait` prints it) and logged once per change.
11. After `/clear` in an idle Claude Code session its conversation id changes and its new journal does not exist yet, so a message waits with reason `claude_resolve:binding_changed` until the session's next turn.

Code: [queue](daemon/internal/queue), [claudeinstance](daemon/internal/claudeinstance), [socketmsg](daemon/internal/socketmsg), [nativeinput](daemon/internal/nativeinput), [runtime](daemon/internal/runtime), [api](daemon/internal/api), [cli](daemon/internal/cli)
