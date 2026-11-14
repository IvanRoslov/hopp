# Ported from rocket

Source: ~/projects/rocket at commit 4f6f383.

Rename table, applied by `scripts/port_pkg.sh` to Go sources and to hook scripts embedded in them:

| rocket | hopp |
|---|---|
| `github.com/IvanRoslov/rocket/` | `github.com/IvanRoslov/hopp/` |
| `ROCKET_` | `HOPP_` |
| `RocketSessionID` | `HoppSessionID` |
| `rocketd-` | `hoppd-` |
| `.rocket/` | `.hopp/` |
| `.rocket-prompt.md` | `.hopp-prompt.md` |
| `rocket-launch.sh`, `rocket-inject-`, `rocket-tmp-`, `rocket-pi-`, `rocket-lock`, `rocket-managed` | the same with `hopp-` |

| Package | Changes beyond the rename table | Tests dropped |
|---|---|---|
| `activity` | None. | None. |
| `socketmsg` | None. Left as is on purpose: `envelope.go` still compares the `from-name` attribute with `"rocket"` (the name the daemon sends as); the ported test `envelope_test.go` asserts that value, so it changes together with the daemon's sender name. | None. |
| `nativeinput` | None. | None. |
| `claudeinstance` | None. | None. |
