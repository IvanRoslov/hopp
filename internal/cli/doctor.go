package cli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"

	"github.com/IvanRoslov/hopp/internal/agent"
	_ "github.com/IvanRoslov/hopp/internal/agent/adapters" // the five harness adapters, for their Available checks
	"github.com/spf13/cobra"
)

// checkStatus is the outcome of a single doctor check.
type checkStatus int

const (
	statusOK checkStatus = iota
	statusWarn
	statusFail
)

func (s checkStatus) icon() string {
	switch s {
	case statusOK:
		return "✅"
	case statusWarn:
		return "⚠️"
	default:
		return "❌"
	}
}

type checkResult struct {
	Status checkStatus
	Name   string
	Detail string
}

func (r checkResult) String() string {
	return fmt.Sprintf("%s %s: %s", r.Status.icon(), r.Name, r.Detail)
}

func newDoctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check tmux, the state directory, the daemon and the harnesses",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			results := runDoctorChecks()
			if printDoctorResults(cmd.OutOrStdout(), results) {
				return &doctorFailedError{}
			}
			return nil
		},
	}
}

// doctorFailedError signals a doctor check failed (❌), mapping to exit
// code 1 like any other API/validation error.
type doctorFailedError struct{}

func (e *doctorFailedError) Error() string { return "one or more doctor checks failed" }

func printDoctorResults(w io.Writer, results []checkResult) (anyFail bool) {
	for _, r := range results {
		fmt.Fprintln(w, r.String())
		if r.Status == statusFail {
			anyFail = true
		}
	}
	return anyFail
}

// runDoctorChecks runs every doctor check in a stable order: tmux, the
// state directory, the daemon (asked, never started), then each registered
// adapter by name.
func runDoctorChecks() []checkResult {
	results := []checkResult{checkTmux(), checkStateDir()}

	c, _, err := connect(false)
	if err != nil {
		results = append(results, checkResult{statusWarn, "daemon", "not running"})
	} else {
		var health struct {
			Pid     int    `json:"pid"`
			Version string `json:"version"`
		}
		if err := c.Get("/v1/health", nil, &health); err != nil {
			results = append(results, checkResult{statusWarn, "daemon", "not answering"})
		} else {
			results = append(results, checkResult{statusOK, "daemon", fmt.Sprintf("running (pid %d, version %s)", health.Pid, health.Version)})
		}
	}

	return append(results, checkAgents()...)
}

func checkTmux() checkResult {
	path, err := exec.LookPath("tmux")
	if err != nil {
		return checkResult{statusFail, "tmux", "not found in PATH"}
	}

	out, err := exec.Command("tmux", "-V").Output()
	if err != nil {
		return checkResult{statusWarn, "tmux", fmt.Sprintf("found (%s), but `tmux -V` failed", path)}
	}

	major, minor, ok := parseTmuxVersion(string(out))
	if !ok {
		return checkResult{statusWarn, "tmux", fmt.Sprintf("version not recognized: %q", string(out))}
	}
	if major < 3 {
		return checkResult{statusFail, "tmux", fmt.Sprintf("version %d.%d < 3.0", major, minor)}
	}
	return checkResult{statusOK, "tmux", fmt.Sprintf("%d.%d (%s)", major, minor, path)}
}

var tmuxVersionRE = regexp.MustCompile(`(\d+)\.(\d+)`)

func parseTmuxVersion(out string) (major, minor int, ok bool) {
	m := tmuxVersionRE.FindStringSubmatch(out)
	if m == nil {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(m[1])
	minor, err2 := strconv.Atoi(m[2])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return major, minor, true
}

// checkStateDir reports the state directory; loading the config creates
// it when it is missing.
func checkStateDir() checkResult {
	cfg, err := loadConfig()
	if err != nil {
		return checkResult{statusFail, "state", err.Error()}
	}
	if info, err := os.Stat(cfg.Home); err != nil || !info.IsDir() {
		return checkResult{statusFail, "state", cfg.Home + " is not a directory"}
	}
	return checkResult{statusOK, "state", cfg.Home}
}

// checkAgents reports each registered adapter's Available check by name.
// An adapter that is not installed is a warning, not a failure: hopp works
// with any subset of the five harnesses.
func checkAgents() []checkResult {
	reg := agent.Registry()
	names := make([]string, 0, len(reg))
	for name := range reg {
		names = append(names, name)
	}
	sort.Strings(names)
	results := make([]checkResult, 0, len(names))
	for _, name := range names {
		if err := reg[name].Available(); err != nil {
			results = append(results, checkResult{statusWarn, "agent:" + name, err.Error()})
			continue
		}
		results = append(results, checkResult{statusOK, "agent:" + name, "available"})
	}
	return results
}
