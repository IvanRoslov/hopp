package cli

import (
	"fmt"
	"os"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// pollInterval is the delay between --wait polls of GET /v1/messages/{id}.
// Overridden in tests to keep them fast.
var pollInterval = 2 * time.Second

func newSendCmd() *cobra.Command {
	var filePath string
	var wait bool

	cmd := &cobra.Command{
		Use:   "send <session> [<text> | -]",
		Short: "Send a message to a session",
		Long: "Sends the text to a session. The text is the argument, a file (--file <path>), or stdin (\"-\" as the\n" +
			"text, or --file -). For a long or markdown text write it to a file and use --file <path>: the shell\n" +
			"never touches it. stdin is read only when something is piped in; an empty text is refused.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) < 1 || len(args) > 2 {
				return &usageError{message: "usage: hopp send <session> (<text> | - | --file <path> | --file -) [--wait]"}
			}
			sessionID := args[0]
			arg := ""
			if len(args) == 2 {
				arg = args[1]
			}
			// One source: the text, or "-"/--file - for stdin, or a file.
			body, err := readBody(cmd, arg, len(args) == 2, filePath, "message", false)
			if err != nil {
				return err
			}

			// Connect to daemon
			c, _, err := connect(true)
			if err != nil {
				return err
			}

			// Determine sender (from HOPP_SESSION_ID env var)
			from := os.Getenv("HOPP_SESSION_ID")

			// POST message
			reqBody := map[string]string{
				"to":   sessionID,
				"body": body,
			}
			if from != "" {
				reqBody["from"] = from
			}

			var resp struct {
				ID     int64  `json:"id"`
				Status string `json:"status"`
				To     string `json:"to,omitempty"`
			}
			if err := c.Post("/v1/messages", reqBody, &resp); err != nil {
				return err
			}

			// A mailbox whose session is not running holds the message
			// until that session reads it, so there is no delivery to poll.
			if resp.Status == "inbox" {
				if flags.JSON {
					return printJSON(cmd, resp)
				}
				cmd.Printf("message %d stored in the inbox of %s (its session is not running)\n", resp.ID, resp.To)
				return nil
			}

			if !wait {
				if flags.JSON {
					return printJSON(cmd, resp)
				}
				cmd.Printf("message %d queued\n", resp.ID)
				return nil
			}

			if !flags.JSON {
				cmd.Printf("message %d queued\n", resp.ID)
			}

			// If --wait, poll until delivered or failed
			return waitForMessage(cmd, c, resp.ID)
		},
	}

	cmd.Flags().StringVar(&filePath, "file", "", "file with the message text ('-' reads stdin)")
	cmd.Flags().BoolVar(&wait, "wait", false, "poll until the recipient has the message (accepted or delivered) or it failed")

	return cmd
}

// msgResp mirrors the message DTO returned by GET /v1/messages/{id}.
type msgResp struct {
	ID       int64  `json:"id"`
	Status   string `json:"status"`
	Attempts int    `json:"attempts"`
	Reason   string `json:"reason,omitempty"`
	Error    string `json:"error,omitempty"`
}

// waitForMessage polls GET /v1/messages/{id} every pollInterval until the
// message is in the recipient's hands or lost. "queued" and "delivering" keep
// the loop going; "accepted" (the recipient holds the text, the journal's
// proof is pending), "delivered" and "failed" end it. Any other status is treated as non-terminal too (logged, not
// errored) so that future statuses added server-side don't break existing
// clients.
func waitForMessage(cmd *cobra.Command, c *client.Client, msgID int64) error {
	label := fmt.Sprintf("message %d", msgID)
	printResult := func(msg msgResp) error { return printJSON(cmd, msg) }
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	waitReason := ""
	for {
		select {
		case <-ticker.C:
			path := apiPath("v1", "messages", fmt.Sprintf("%d", msgID))
			var msg msgResp
			if err := c.Get(path, nil, &msg); err != nil {
				return err
			}

			switch msg.Status {
			case "delivered":
				if flags.JSON {
					return printResult(msg)
				}
				cmd.Printf("%s delivered\n", label)
				return nil
			case "failed":
				reason := msg.Reason
				if reason == "" && msg.Error != "" {
					reason = msg.Error
				}
				if reason == "" {
					reason = "unknown error"
				}
				if flags.JSON {
					_ = printResult(msg)
				} else {
					cmd.PrintErrf("%s failed: %s\n", label, reason)
				}
				return fmt.Errorf("message delivery failed")
			case "accepted":
				// The recipient holds the text and reads it at its next step.
				// Waiting on for the journal's proof would hang two sessions
				// that send to each other at once: each sits in its own
				// command and reads nothing until that command returns.
				if flags.JSON {
					return printResult(msg)
				}
				cmd.Printf("%s accepted (the agent has it and reads it after its current step)\n", label)
				return nil
			case "queued", "delivering":
				// Still in flight, continue polling. A queued message on the
				// Claude route may carry why it waits; name it once per change.
				if msg.Status == "queued" && msg.Reason != waitReason && !flags.JSON {
					if msg.Reason != "" {
						cmd.Printf("%s waiting: %s\n", label, msg.Reason)
					}
				}
				if msg.Status == "queued" {
					waitReason = msg.Reason
				}
				continue
			default:
				// Unknown/future status: keep polling rather than erroring.
				cmd.PrintErrf("debug: message %d has unrecognized status %q, continuing to poll\n", msgID, msg.Status)
				continue
			}
		}
	}
}
