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
| `socketmsg` | `envelope.go`: the daemon's own sender name, compared with the `from-name` attribute in `Unwrap`, is `"hopp"` instead of `"rocket"`. The test values that stand for that name follow it in `envelope_test.go` (case `"rocket не меняется"` is now `"hopp не меняется"`), `envelope_id_test.go` and `socketmsg_test.go`. Arbitrary test labels such as `NewReceipts("rocket-test")` stay. | None. |
| `nativeinput` | None. | None. |
| `claudeinstance` | None. | None. |
