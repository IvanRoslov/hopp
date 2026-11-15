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

// buildSendBody extracts the message body from args and/or filePath.
//
// Argument-shape (XOR) validation — no args, wrong arg count, or both a
// positional body and --file supplied — is the caller's (RunE's)
// responsibility so that all usage violations map to exit code 3
// consistently. buildSendBody assumes it is called with a valid shape and
// only reads the body from whichever source was given, then checks it is
// non-empty.
//
// The body is read through readTextInput, so --file also accepts "-",
// meaning "read the body from stdin".
func buildSendBody(cmd *cobra.Command, args []string, filePath string) (string, error) {
	var body string
	var err error

	if filePath != "" {
		body, err = readTextInput(cmd, filePath)
		if err != nil {
			return "", err
		}
	} else if len(args) == 2 {
		body = args[1]
	}

	if body == "" {
		return "", fmt.Errorf("body must not be empty")
	}

	return body, nil
}

func newSendCmd() *cobra.Command {
	var filePath string
	var wait bool

	cmd := &cobra.Command{
		Use:   "send <session> [<text>]",
		Short: "Send a message to a session",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate argument count
			if len(args) < 1 || len(args) > 2 {
				return &usageError{message: "usage: hopp send <session> [<text>] [--file <path>] [--wait]"}
			}

			// If --file is provided, args should be [session] only
			if filePath != "" && len(args) != 1 {
				return &usageError{message: "usage: hopp send <session> [<text>] [--file <path>] [--wait]"}
			}

			// If neither --file nor a positional body is given, there is no
			// message body at all — usage violation.
			if filePath == "" && len(args) == 1 {
				return &usageError{message: "usage: hopp send <session> [<text>] [--file <path>] [--wait]"}
			}

			sessionID := args[0]

			// Build message body
			body, err := buildSendBody(cmd, args, filePath)
			if err != nil {
				return fmt.Errorf("invalid message: %v", err)
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
			}
			if err := c.Post("/v1/messages", reqBody, &resp); err != nil {
				return err
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
	cmd.Flags().BoolVar(&wait, "wait", false, "poll until message is delivered or failed (accepted is announced on the way)")

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
// message reaches a terminal status. "queued", "delivering" and "accepted"
// are non-terminal and keep the loop going — "accepted" (the text is in a
// Codex recipient's hands, journal confirmation pending) is announced once;
// "delivered" and "failed" are terminal. Any other status is treated as non-terminal too (logged, not
// errored) so that future statuses added server-side don't break existing
// clients.
func waitForMessage(cmd *cobra.Command, c *client.Client, msgID int64) error {
	label := fmt.Sprintf("message %d", msgID)
	printResult := func(msg msgResp) error { return printJSON(cmd, msg) }
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	announcedAccepted := false
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
				if !announcedAccepted && !flags.JSON {
					cmd.Printf("%s accepted (the agent has it; waiting for confirmation)\n", label)
				}
				announcedAccepted = true
				continue
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
