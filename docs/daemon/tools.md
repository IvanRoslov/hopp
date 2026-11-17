---
kind: leaf
up: [[docs/daemon/README]]
verified: 2026-11-16 — against the code on main, go test ./... and a smoke run in a temp HOPP_HOME (Plan 6)
---

# The tool catalog

The tool catalog tells every agent which tools exist, how to use them, which are paid and which the human switched off, and where the human's rules for choosing between them are.

1. The catalog is files under the hopp home: `tools/`, one folder per tool holding `tool.yaml` and `USAGE.md`, plus the human's free-form `rules.md`. Anything else a tool needs (a binary, scripts, references) lives in its own folder.
2. `hopp tools …` reads these files directly and the daemon process takes no part, so the catalog works while the daemon is stopped and a change applies at once, also to running sessions.
3. hopp only describes tools: it never runs them, keeps no secrets (a tool names the environment variables it needs, never their values) and blocks nothing. Asking before a paid call and leaving a switched-off tool alone is the agent's responsibility.
4. A tool is one of three kinds: a command the agent runs, a pointer to an MCP server the human connected by hand (hopp does not connect it), or a guide that is only instructions. A tool may be limited to some harnesses, which matters for MCP servers connected in only some of them.
5. A tool the human switched off is left out of `hopp tools list`, `prompt` and `show` (which refuses it unless `--all`). `hopp tools enable|disable` changes only that switch in `tool.yaml`.
6. `hopp tools prompt --harness <name>` prints the section for a session's start text: one line per switched-on tool of that harness, marked paid or MCP, and four rules (read `show` before use, read `rules` before choosing, Go before a paid call, ask and record a lesson instead of substituting). The daemon puts it into no start text; the app adds it to the start texts of the sessions it launches (see [[docs/app/shell]]).
7. The rules file is not copied into the start text: the agent reads `hopp tools rules` before each choice, so the human's edit reaches sessions that are already running.
8. A broken tool (a bad `tool.yaml`, a missing `USAGE.md`, a name that differs from its folder) is named on stderr and does not hide the others. `hopp tools check` reports it, and also a command that does not exist and an environment variable that is not set, and exits non-zero when anything is wrong.
9. `hopp tools guide` tells an agent how to add a tool; the human confirms whether it is paid and switched on. `hopp tools import <file>` creates tools from rocket's `registry.yaml` and only reads that file.

Code: [toolcatalog](daemon/internal/toolcatalog), [cli](daemon/internal/cli)
