package cli

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// execCommand replaces the process with argv. Tests swap it out.
var execCommand = func(argv []string) error {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return fmt.Errorf("%s: command not found: %w", argv[0], err)
	}
	return syscall.Exec(path, argv, os.Environ())
}

func newAttachCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "attach <id>",
		Short: "Attach to a session's tmux session",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			return attachTo(cmd, c, args[0])
		},
	}
}

// attachTo asks the daemon for id's attach command and runs it in place of
// this process.
func attachTo(cmd *cobra.Command, c *client.Client, id string) error {
	var resp struct {
		Command []string `json:"command"`
	}
	if err := c.Get(apiPath("v1", "sessions", id, "attach"), nil, &resp); err != nil {
		return err
	}
	if len(resp.Command) == 0 {
		return fmt.Errorf("daemon returned an empty attach command")
	}

	argv := resp.Command
	// Inside an existing tmux client, "tmux attach -t <target>" would
	// nest a tmux session inside another; switch-client instead,
	// keeping the same exact-match target.
	if os.Getenv("TMUX") != "" && len(argv) >= 2 && argv[0] == "tmux" && argv[1] == "attach" {
		argv = append([]string{"tmux", "switch-client"}, argv[2:]...)
	}

	if flags.JSON {
		return printJSON(cmd, map[string]any{"command": argv})
	}
	return execCommand(argv)
}
