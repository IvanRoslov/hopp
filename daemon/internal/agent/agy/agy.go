// Package agy implements the agent.Agent adapter for Google's Antigravity
// CLI (`agy`), the interactive Gemini agent.
//
// Facts this package relies on were checked live against agy 1.5.14 on
// 2026-11-21:
//
//   - A folder agy has not seen stops on a «Do you trust the contents of this
//     project?» screen, and --dangerously-skip-permissions does not remove
//     it. `--settings '{"trustedWorkspaces":["<dir>"]}'` does, for this
//     session only: the user's settings.json is left as it was.
//   - `-i <prompt>` runs the prompt as the first turn and keeps the session
//     interactive.
//   - agy reads AGENTS.md of the folder into its context, and the commands it
//     runs inherit the session's environment.
//   - The interactive TUI has no channel for outside input (`agy acp` and
//     `--input-format stream-json` run without the TUI), so hopp types
//     messages into the pane. Enter during a turn puts the text into agy's
//     own queue («▸ … (alt+m to send immediately)»), which agy hands to the
//     model when the turn ends.
//   - Every conversation has a journal, transcript.jsonl, written within a
//     second or two of each step; see journal.go.
package agy

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/IvanRoslov/hopp/internal/agent"
)

type Agy struct{}

var (
	_ agent.BracketedPaster   = (*Agy)(nil)
	_ agent.BusyInputAccepter = (*Agy)(nil)
)

// New creates a new agy agent.
func New() agent.Agent { return &Agy{} }

func (a *Agy) Name() string { return "agy" }

// BracketedPaste makes the queue paste a message as one bracketed paste, so
// a multi-line message stays one draft instead of submitting at each newline.
func (a *Agy) BracketedPaste() bool { return true }

// AcceptsInputWhileBusy implements agent.BusyInputAccepter: text submitted
// during a turn lands in agy's own queue and reaches the model on its own.
func (a *Agy) AcceptsInputWhileBusy() bool { return true }

// Efforts is nil: an agy model id already names its thinking level
// (gemini-4-neon-high), so a profile picks the level by picking the model.
func (a *Agy) Efforts() []string { return nil }

// resolveBinary finds agy in PATH, else where its installer puts it.
func resolveBinary() (string, error) {
	if bin, err := exec.LookPath("agy"); err == nil {
		return filepath.Abs(bin)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("agy binary not found in PATH")
	}
	bin := filepath.Join(home, ".local", "bin", "agy")
	if info, err := os.Stat(bin); err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0 {
		return bin, nil
	}
	return "", fmt.Errorf("agy binary not found in PATH or at %s", bin)
}

func (a *Agy) Available() error { _, err := resolveBinary(); return err }

// trustSettings is the --settings value that marks dir trusted for one
// session. Both the path as given and its physical form are listed, because
// agy compares against the folder it finds itself in.
func trustSettings(dir string) string {
	dirs := []string{dir}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil && resolved != dir {
		dirs = append(dirs, resolved)
	}
	b, _ := json.Marshal(map[string][]string{"trustedWorkspaces": dirs})
	return string(b)
}

// LaunchCommand builds the interactive agy invocation. Tool permission
// prompts are approved up front, like the other pane-typed harnesses.
func (a *Agy) LaunchCommand(spec agent.LaunchSpec) []string {
	bin, err := resolveBinary()
	if err != nil {
		return nil // Available is checked before launch.
	}
	cmd := []string{bin, "--dangerously-skip-permissions", "--settings", trustSettings(spec.WorktreePath)}
	if spec.Model != "" {
		cmd = append(cmd, "--model", spec.Model)
	}
	if spec.FirstMessage != "" {
		cmd = append(cmd, "-i", spec.FirstMessage)
	}
	return cmd
}

// Env returns the session's variables. AGY_CLI_DISABLE_AUTO_UPDATE keeps agy
// from replacing its own binary under a running session.
func (a *Agy) Env(spec agent.LaunchSpec) map[string]string {
	return map[string]string{
		"AGY_CLI_DISABLE_AUTO_UPDATE": "1",
		"HOPP_SESSION_ID":             spec.SessionID,
		"HOPP_PARENT_ID":              spec.ParentID,
		"HOPP_SOCKET":                 spec.SocketPath,
	}
}

// SetupWorkspace writes the system prompt into AGENTS.md, which agy reads.
func (a *Agy) SetupWorkspace(spec agent.LaunchSpec) error {
	if err := agent.UpsertAgentsMD(spec.WorktreePath, spec.SystemPrompt); err != nil {
		return fmt.Errorf("upsert AGENTS.md: %w", err)
	}
	return nil
}

func init() { agent.Register("agy", New) }
