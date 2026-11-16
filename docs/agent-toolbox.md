---
last-verified: 2026-11-15
canonical: true
---

# Agent toolbox — build, deploy & test hopp

**Point an agent at this file** to give it the tools used to build, configure, deploy, and test the system. This is the canonical procedural reference for tool selection; playbooks link here for concrete commands.

> Ground every entry below in something real — a command you ran, a file in the repo, a
> tool you called. Mark anything unverified "(confirm in repo)" rather than guessing.

## 0. Environment at a glance

- Vault: `<TODO: org/repo of this knowledge base>` (this repo).
- Code: Docs and code share this repo. The vault is the root-level `*.md` files and `docs/`; everything else is code. A leaf's `Code:` line links the directory of this repo that holds the code for its facts.
- <TODO: the contract, guide, or standard this project must follow, if any.>

## 1. Build & run locally

```bash
make build          # builds bin/hopp
make start          # builds, starts the daemon, prints its status
make restart        # builds, then stops and starts the daemon
make stop           # stops the daemon and waits until it has exited
bin/hopp doctor     # tmux, the state directory, the daemon, the five harnesses
bin/hopp logs -n 50 # the daemon log, read from disk without starting the daemon
make install        # links /opt/homebrew/bin/hopp to bin/hopp (a symlink, never a copy)
```

Agents inside sessions call `hopp` by name (`hopp ask`, `hopp inbox next` from the mailbox notice), so it must be on their PATH; `make install` puts it there, and every later `make build` updates it through the link. Until then give agents the absolute path to `bin/hopp`.

The daemon keeps everything in `~/.hopp`; set `HOPP_HOME` to a temporary folder to run a throwaway daemon. Every `hopp` command that talks to the daemon starts it when it is not running, except `logs`, `doctor`, `daemon status` and `daemon stop`, so stop it before you rebuild, or `make restart` does it in the right order.

## 2. Deploy & configure

There is no deployment: hopp runs from `bin/hopp` on the author's machine, and a change takes effect after `make restart`. The daemon reads `DEEPSEEK_API_KEY` from `~/.hopp/deepseek-api-key` at start when its environment lacks it.

## 3. Domain-specific tooling

The daemon's state is one SQLite database, `~/.hopp/hopp.db`. Read it without writing while the daemon runs with `sqlite3 -readonly ~/.hopp/hopp.db '<query>'`; when the daemon is stopped, open it as `sqlite3 "file:$HOME/.hopp/hopp.db?immutable=1"`. The tables that explain a delivery are `messages` (status, attempts, reason, `delivery_transport`), `claude_deliveries` (the pinned journal boundary and phase of a Claude Code send) and `claude_consumed_records`. An agent's own journal is the evidence of what it received: Claude Code and DeepSeek under `~/.claude/projects/<folder slug>/<session id>.jsonl`, Codex under `~/.codex/sessions/`, Kimi Code under `~/.kimi-code/sessions/`, Pi under `~/.pi/agent/sessions/`.

## 4. Tests

- `make test` runs `go test ./...` inside `daemon/`, where the Go module lives (its module path stays `github.com/IvanRoslov/hopp`); run `go vet ./...` and `gofmt -l .` there too.
- `make build` builds the program into `bin/hopp`.
- `make app-pack` builds an unsigned `app/dist/hopp-darwin-arm64/hopp.app` for this Mac (not signed, not installed anywhere).
- `make app-test` type-checks the desktop app in `app/` and runs its vitest unit tests and its Playwright end-to-end tests (Electron), all against a fake daemon on a temporary socket; `make app-install` (`npm ci`) comes first, and `make app-dev` runs the app against the daemon of `HOPP_HOME`.
- The Pi delivery extension tests run with `node --experimental-strip-types --test daemon/internal/agent/pi/delivery-extension.test.ts`; `go test` does not run them.

## 5. Verify the running system

Run `bin/hopp daemon status` (pid and version), then `bin/hopp doctor`. To see a session really run, launch one in a scratch folder with `bin/hopp run <dir> --agent <harness>`, check `bin/hopp ls` and the pane with `tmux capture-pane -p -t '=<id>:'`, then stop it with `bin/hopp kill <id>`. `bin/hopp events --session <id>` shows what happened to it. To see a message travel, run `bin/hopp send --wait <id> '<text>'` (it prints `queued`, `accepted`, any wait reason, and `delivered` or `failed`), `bin/hopp messages <id>` for the history with each message's status and reason, and `bin/hopp events --follow --session <id>` to watch activity and delivery live.

The human's commands:

```bash
bin/hopp chat <id> [--follow]          # the session's conversation from the agent's journal
bin/hopp waiting                       # everything that waits for the human: open asks and screen questions
bin/hopp run <dir> --profile <p> --permission-mode manual   # Claude Code without skipped permission prompts
bin/hopp run <dir> --spawn-dir <path>  # the new session may launch sessions only under <path> (repeatable)
bin/hopp run <dir> --label k=          # do not inherit label k from the parent
bin/hopp answer <id> [<choice>]        # show or answer the question a session's screen waits on
bin/hopp asks [--all] [--label k=v]    # decision requests; answer one with:
bin/hopp reply <ask-id> [<choice>] [-m <text>]
bin/hopp usage [--tree <id>] [--collect] [--label k=v]   # tokens per session and model, with a total
bin/hopp rm <id> [--recursive]         # remove an ended session's record; the id is free again
bin/hopp rm --ended                    # remove every ended session's record
bin/hopp mailbox add|rm <id>           # a mailbox holds mail while no session of that id runs
bin/hopp mailbox ls                    # mailboxes with unread and total counts
bin/hopp inbox [--mailbox <id>]        # a mailbox's unread messages; inbox next takes the oldest
```

Inside a session an agent asks with `hopp ask "<text>" [--option <choice>]… [--wait]` and withdraws with `hopp ask withdraw <ask-id>`.

The tool catalog (files under `~/.hopp/tools`; no daemon needed):

```bash
bin/hopp tools list [--all] [--harness <h>]   # switched-on tools; --all includes switched-off ones
bin/hopp tools show <name> [--all]            # a tool's card and USAGE.md
bin/hopp tools rules                          # the human's rules for choosing tools
bin/hopp tools prompt --harness <h>           # the tools section for a session's start text
bin/hopp tools enable|disable <name>...
bin/hopp tools check [<name>]                 # files, command on disk, environment set
bin/hopp tools path [<name>]                  # where the catalog or a tool lives
bin/hopp tools guide                          # how to add a tool
bin/hopp tools import <registry.yaml> [--update]   # from rocket's format; the file is only read
```

Posts, notes to the human that wait for no answer (from an agent, or the human's own with `--from ""`):

```bash
bin/hopp post "<text>" [--label k=v] [--attach <path|url|name@version>]   # or -f <file>, or stdin; prints the id
bin/hopp posts [--label k=v] [--from <id>] [--after <id>] [--limit <n>]
```

Artifacts, files kept in immutable versions (scope: the root of `$HOPP_SESSION_ID`'s tree, or `--scope`):

```bash
bin/hopp artifact publish <file> [--name <n>] [--label k=v] [--scope <s>]   # prints name@version
bin/hopp artifacts [--all-versions] [--label k=v] [--scope <s>]
bin/hopp artifact get <name>[@<version>] [--scope <s>]                       # prints the stored path
```

Lessons, from an agent or the human:

```bash
bin/hopp lesson "<text>" [--label k=v]   # or -f <file>, or the text on stdin; prints the id
bin/hopp lessons [--all|--closed] [--label k=v] [--from <id>]
bin/hopp lessons close <id>...
```

## Related

- [[docs/invariants]] — the rules these tools must not be used to break
- [[docs/playbooks/README]] — runbooks that build on this toolbox
- [[docs/overview]] — what the system is
