package cli

import (
	"errors"
	"fmt"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/IvanRoslov/hopp/internal/daemon"
	"github.com/spf13/cobra"
)

func newDaemonCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "daemon",
		Short: "Manage the hopp daemon",
	}
	cmd.AddCommand(newDaemonRunCmd())
	cmd.AddCommand(newDaemonStartCmd())
	cmd.AddCommand(newDaemonStopCmd())
	cmd.AddCommand(newDaemonStatusCmd())
	return cmd
}

// newDaemonRunCmd runs hoppd in the foreground. It is the only daemon
// subcommand that does not autostart another daemon instance — it *is* the
// daemon.
func newDaemonRunCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "run",
		Short: "Run the daemon in this process (foreground)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := loadConfig()
			if err != nil {
				return err
			}
			return daemon.Run(cfg)
		},
	}
}

func newDaemonStartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Start the daemon in the background (if it is not running)",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, _, err := connect(true)
			if err != nil {
				return err
			}
			cmd.Println("hoppd running")
			return nil
		},
	}
}

func newDaemonStopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the daemon and wait until it has exited",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, cfg, err := connect(false)
			if err != nil {
				if errors.Is(err, client.ErrDaemonUnavailable) {
					cmd.Println("not running")
					return nil
				}
				return err
			}
			// Capture the pid before requesting shutdown: the daemon
			// removes its pid file as part of the shutdown it's about to
			// start, so we won't be able to read it afterwards.
			pid, pidErr := daemon.ReadPid(cfg)
			if err := c.Post("/v1/shutdown", nil, nil); err != nil {
				return err
			}
			if pidErr == nil {
				if err := daemon.WaitForExit(pid, daemon.StopWaitTimeout); err != nil {
					return fmt.Errorf("daemon did not exit cleanly: %w", err)
				}
			}
			cmd.Println("stopped")
			return nil
		},
	}
}

func newDaemonStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show whether the daemon is running",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(false)
			if err != nil {
				if errors.Is(err, client.ErrDaemonUnavailable) {
					cmd.Println("not running")
					return nil
				}
				return err
			}
			var health struct {
				Pid       int    `json:"pid"`
				Version   string `json:"version"`
				StartedAt int64  `json:"started_at"`
			}
			if err := c.Get("/v1/health", nil, &health); err != nil {
				return err
			}
			cmd.Println(fmt.Sprintf("hoppd running (pid %d, version %s)", health.Pid, health.Version))
			return nil
		},
	}
}
