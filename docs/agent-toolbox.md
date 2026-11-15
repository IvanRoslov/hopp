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
```

The daemon keeps everything in `~/.hopp`; set `HOPP_HOME` to a temporary folder to run a throwaway daemon. Every `hopp` command that talks to the daemon starts it when it is not running, except `logs`, `doctor`, `daemon status` and `daemon stop`, so stop it before you rebuild, or `make restart` does it in the right order.

## 2. Deploy & configure

There is no deployment: hopp runs from `bin/hopp` on the author's machine, and a change takes effect after `make restart`. The daemon reads `DEEPSEEK_API_KEY` from `~/.hopp/deepseek-api-key` at start when its environment lacks it.

## 3. Domain-specific tooling

The daemon's state is one SQLite database, `~/.hopp/hopp.db`. Read it without writing while the daemon runs with `sqlite3 -readonly ~/.hopp/hopp.db '<query>'`; when the daemon is stopped, open it as `sqlite3 "file:$HOME/.hopp/hopp.db?immutable=1"`. The tables that explain a delivery are `messages` (status, attempts, reason, `delivery_transport`), `claude_deliveries` (the pinned journal boundary and phase of a Claude Code send) and `claude_consumed_records`. An agent's own journal is the evidence of what it received: Claude Code and DeepSeek under `~/.claude/projects/<folder slug>/<session id>.jsonl`, Codex under `~/.codex/sessions/`, Kimi Code under `~/.kimi-code/sessions/`, Pi under `~/.pi/agent/sessions/`.

## 4. Tests

- `make test` runs `go test ./...`.
- `make build` builds the program into `bin/hopp`.
- The Pi delivery extension tests run with `node --experimental-strip-types --test internal/agent/pi/delivery-extension.test.ts`; `go test` does not run them.

## 5. Verify the running system

Run `bin/hopp daemon status` (pid and version), then `bin/hopp doctor`. To see a session really run, launch one in a scratch folder with `bin/hopp run <dir> --agent <harness>`, check `bin/hopp ls` and the pane with `tmux capture-pane -p -t '=<id>:'`, then stop it with `bin/hopp kill <id>`. `bin/hopp events --session <id>` shows what happened to it. To see a message travel, run `bin/hopp send --wait <id> '<text>'` (it prints `queued`, `accepted`, any wait reason, and `delivered` or `failed`), `bin/hopp messages <id>` for the history with each message's status and reason, and `bin/hopp events --follow --session <id>` to watch activity and delivery live.

## Related

- [[docs/invariants]] — the rules these tools must not be used to break
- [[docs/playbooks/README]] — runbooks that build on this toolbox
- [[docs/overview]] — what the system is
