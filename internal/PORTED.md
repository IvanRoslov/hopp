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
| `runtime` | `tmux.go`: the tmux paste-buffer prefix is `"hopp-"` instead of `"rocket-"`; the assertions on it (`"rocket-sess"` is now `"hopp-sess"`) follow in `tmux_inject_orphan_test.go`, `tmux_inject_pi_test.go` and `tmux_inject_kimi_test.go`. `kimipane_test.go`: the rename table had rewritten the expected path to `/.hopp/scratch/kimi-recon/untrusted`; it is restored to `/.rocket/scratch/kimi-recon/untrusted` to match the real Kimi capture `testdata/kimi-trust.pane`, which is not edited. | None. |
| `agent` | Top-level files only; adapters are separate rows. `LaunchSpec` loses `Creative`, `Kind`, `ProjectID`, `RepoID`, `Feature`, `BrainstormSkill`. Removed: `BrainstormSkillShipper`, `ShipsBrainstormSkill`, `LaunchSpec.DevelopmentOrchestrator`. `UpsertAgentsMD(worktreePath, systemPrompt string) error` loses `stripSkills` and writes the prompt as given; the package no longer imports `prompts`, and its doc comment drops the sentence about skill stripping. `rocketBlockRe` is renamed `hoppBlockRe`, and the AGENTS.md block markers are `<!-- hopp:start -->` / `<!-- hopp:end -->` instead of `<!-- rocket:start -->` / `<!-- rocket:end -->`, so hopp leaves a block rocket wrote untouched; the doc comment says "the hopp prompt block". New tests `agentsmd_test.go`. `ExcludeFromGit` unchanged: it already writes nothing outside a git repository. New test `trim_test.go`. | None; no ported test asserted a removed item. |
| `agent/claudecode` | Removed: the orchestrator skill sync in `SetupWorkspace` and its git excludes, `ShipsBrainstormSkill`, `orchestratorSkillsRelDir`, `syncOrchestratorSkill`, `orchestratorSkillExcludes`, the `prompts` import, and `HOPP_KIND`, `HOPP_PROJECT_ID`, `HOPP_REPO_ID`, `HOPP_FEATURE` in `Env` (`HOPP_PARENT_ID` was unconditional in rocket and stays so). Hand renames: the hook-script directory `filepath.Join(worktreePath, ".rocket")` becomes `".hopp"` in `writeActivityHookScript` and `writeQuizHookScript` (the rename table had already moved the hook paths in settings to `.hopp/`), with the test paths on it in `claudecode_test.go`; the curl host in both hook scripts `http://rocket/` becomes `http://hopp/` (endpoint paths `/v1/internal/activity` and `/v1/internal/quiz` and payloads unchanged); the two `rocket` words in the quiz hook script's own comments become `hopp`. Deliberate exception to the rename table: the `~/.claude.json` lock file stays `.claude.json.rocket-lock` (the table had made it `hopp-lock`), so hopp and rocket take the same flock when they rewrite that shared file. Test inputs lose the removed `LaunchSpec` fields. New test `hopp_test.go`. | `skill_test.go` deleted: `TestSetupWorkspaceLaysCustomSkillForOrchestrator`, `TestSetupWorkspaceLaysCustomSkillForVersionedRecord`, `TestSetupWorkspaceRemovesCustomSkillForStockOrchestrator`, `TestSetupWorkspaceNoSkillForWorker`, `TestSetupWorkspaceCustomSkillIsGitIgnored`, `TestClaudeCodeShipsBrainstormSkill`. Cut from `TestEnvCompleteness`: the `HOPP_KIND`, `HOPP_PROJECT_ID`, `HOPP_REPO_ID`, `HOPP_FEATURE` expectations. |
| `agent/deepseek` | None in `deepseek.go` or `catalog.go`. Test inputs lose the removed `LaunchSpec` fields. New test `hopp_test.go`. | Cut: the compile-time check `var _ agent.BrainstormSkillShipper`; from `TestEnv`, the `HOPP_KIND`, `HOPP_PROJECT_ID`, `HOPP_REPO_ID`, `HOPP_FEATURE` expectations; from `TestInheritedClaudeLaunchAndEfforts`, the `ShipsBrainstormSkill` assertion. |
