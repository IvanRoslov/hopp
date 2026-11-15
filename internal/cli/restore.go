package cli

import "github.com/spf13/cobra"

func newRestoreCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "restore <id>",
		Short: "Relaunch a stopped or dead session in its folder",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return postSessionAction(cmd, args[0], "restore", map[string]any{"force": force})
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "kill a running session's tmux and relaunch it")
	return cmd
}
