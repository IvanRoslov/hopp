# Invariants

The hard rules that must never be broken. Each has a stable ID so other docs can reference it as a digest. If a task seems to require breaking one, stop and escalate — do not work around it silently.

A rule earns a place here only if breaking it causes damage that is expensive or impossible to undo: data loss, a security hole, a broken contract others depend on. Preferences and conventions belong in [[CLAUDE]], not here.

## Isolation from rocket and from the human's tmux

- **INV-001 — hopp never destroys a tmux session it does not own.** Every destroy goes through one check that the tmux session's environment carries the hopp session id; a session that fails it is left running and the hopp session becomes `errored`. Live tmux sessions hopp did not record are never touched or adopted. Tested by `TestKillRefusesForeignTmux`, `TestRestoreForceRefusesForeignTmux` and `TestReconcileIgnoresForeignTmux` (`internal/session`), and `TestSpawnIDTakenByForeignTmux` for the id it picks.
- **INV-002 — hopp writes nothing under `~/.rocket`.** Its state lives in `~/.hopp` (or `$HOPP_HOME`), and what a launch writes into a folder never names rocket. Tested by `TestHomeDefaultsToDotHopp` (`internal/config`) and `TestSetupWorkspaceWritesNothingNamedRocket` in the `claudecode`, `codex`, `kimicode` and `pi` adapter packages (`deepseek` writes through `claudecode`); the live check of 2026-11-15 compared the `~/.rocket` listing before and after.

## Business logic — hopp

- **INV-050 — no scenario concept in the daemon.** The sessions table, the session JSON and the agent launch spec have no role, task, project, repository, feature, branch, PR or CI field. Tested by `TestSessionsTableHasNoScenarioColumns` (`internal/store`), `TestSessionJSONHasNoScenarioKeys` (`internal/api`) and `TestLaunchSpecHasNoScenarioFields` (`internal/agent`).

## Related

- [[docs/agent-toolbox]] — the tools you use while respecting these rules
- [[docs/overview]] — the system these rules govern
