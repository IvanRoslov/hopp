---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-15 — against the routes and commands on main
---

# What the daemon does not do yet

These parts of the design are not on `main`. The code they need is partly ported but not wired.

1. Agents cannot message each other yet: there is no send command and no delivery queue. The three delivery transports (Claude Code socket, Pi socket channel, tmux paste) are ported with their tests but nothing calls them.
2. Because there is no queue, a launch with a first message is refused for Kimi Code, the one harness that takes its first message by typing it in; the others pass it on their command line.
3. The daemon does not track activity: a session's activity stays empty, and the hook scripts a Claude Code session runs report to routes the daemon does not serve yet, which they ignore silently.
4. There is no live event stream: `hopp events` reads the log as it is, and nothing follows it.
5. The parent is not told when a child is stuck on a start screen or a permission prompt or its turn failed, and there is no periodic summary of stuck children.

Code: [socketmsg](internal/socketmsg), [nativeinput](internal/nativeinput), [claudeinstance](internal/claudeinstance), [api](internal/api)
