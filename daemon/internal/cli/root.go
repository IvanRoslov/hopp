// Package cli implements the hopp command line: `hopp daemon run` is the
// daemon, every other command is a client of it over the unix socket.
package cli

import (
	"errors"
	"os"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/IvanRoslov/hopp/internal/version"
	"github.com/spf13/cobra"
)

type globalFlags struct {
	JSON   bool
	Socket string
}

var flags globalFlags

// Error types for exit code mapping
type usageError struct {
	message string
}

func (e *usageError) Error() string {
	return e.message
}

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:           "hopp",
		Short:         "Run AI agents in tmux sessions and let them message each other",
		Version:       version.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.SetVersionTemplate("hopp {{.Version}}\n")
	// cobra's Print/Printf/Println write to OutOrStderr(), i.e. stderr
	// unless an out writer is set. Every command in this package uses that
	// family to print its RESULT, and a result on stderr cannot be piped
	// into grep or jq. Setting the writer once on the root fixes all of
	// them at once: subcommands inherit it through cobra's parent walk.
	// Diagnostics keep using PrintErr*, which reads errWriter and is
	// unaffected — they stay on stderr, which is where they belong.
	root.SetOut(os.Stdout)
	root.PersistentFlags().BoolVar(&flags.JSON, "json", false, "print the API's JSON")
	root.PersistentFlags().StringVar(&flags.Socket, "socket", "", "path to the daemon socket")
	root.AddCommand(newDaemonCmd())
	root.AddCommand(newRunCmd())
	root.AddCommand(newLsCmd())
	root.AddCommand(newKillCmd())
	root.AddCommand(newRmCmd())
	root.AddCommand(newRestoreCmd())
	root.AddCommand(newAttachCmd())
	root.AddCommand(newModelsCmd())
	root.AddCommand(newSendCmd())
	root.AddCommand(newMessagesCmd())
	root.AddCommand(newInboxCmd())
	root.AddCommand(newMailboxCmd())
	root.AddCommand(newChatCmd())
	root.AddCommand(newAnswerCmd())
	root.AddCommand(newAskCmd())
	root.AddCommand(newAsksCmd())
	root.AddCommand(newWaitingCmd())
	root.AddCommand(newReplyCmd())
	root.AddCommand(newLessonCmd())
	root.AddCommand(newLessonsCmd())
	root.AddCommand(newPostCmd())
	root.AddCommand(newPostsCmd())
	root.AddCommand(newArtifactCmd())
	root.AddCommand(newArtifactsCmd())
	root.AddCommand(newToolsCmd())
	root.AddCommand(newEventsCmd())
	root.AddCommand(newUsageCmd())
	root.AddCommand(newLogsCmd())
	root.AddCommand(newDoctorCmd())
	return root
}

// Execute returns the exit code for the process (0/1/2/3).
func Execute() int {
	if err := NewRootCmd().Execute(); err != nil {
		os.Stderr.WriteString("hopp: " + err.Error() + "\n")
		return exitCode(err)
	}
	return 0
}

// exitCode maps error types to exit codes:
// 0: success
// 1: API/validation error (default)
// 2: daemon unavailable
// 3: usage error
func exitCode(err error) int {
	var usageErr *usageError

	if errors.As(err, &usageErr) {
		return 3
	}
	if errors.Is(err, client.ErrDaemonUnavailable) {
		return 2
	}
	return 1
}
