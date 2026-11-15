package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// inboxMessage mirrors internal/api.inboxMessageResponse.
type inboxMessage struct {
	ID        int64  `json:"id"`
	Mailbox   string `json:"mailbox"`
	From      string `json:"from"`
	Body      string `json:"body"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"created_at"`
}

// newInboxCmd is rocket's `rocket inbox` for hopp's mailboxes.
func newInboxCmd() *cobra.Command {
	var mailbox string
	cmd := &cobra.Command{
		Use:   "inbox",
		Short: "A mailbox's unread messages (read them one by one with inbox next)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) != 0 {
				return &usageError{message: "usage: hopp inbox [--mailbox <name>]"}
			}
			name, err := resolveMailbox(mailbox)
			if err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var resp struct {
				Messages []inboxMessage `json:"messages"`
			}
			if err := c.Get(apiPath("v1", "mailboxes", name, "inbox")+"?status=unread", nil, &resp); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, resp)
			}
			cmd.Printf("%d unread\n", len(resp.Messages))
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			for _, m := range resp.Messages {
				fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\n", m.ID, dash(m.From), age(m.CreatedAt), firstLine(m.Body))
			}
			return tw.Flush()
		},
	}
	cmd.PersistentFlags().StringVar(&mailbox, "mailbox", "", "mailbox name (default: $HOPP_SESSION_ID)")
	cmd.AddCommand(newInboxNextCmd(&mailbox))
	cmd.AddCommand(newInboxPeekCmd(&mailbox))
	return cmd
}

// newInboxNextCmd takes the oldest unread message and marks it read. One at a
// time is the whole point: the session processes a message, then asks for the
// next one, instead of being handed a wall of text it has to triage in one go.
func newInboxNextCmd(mailbox *string) *cobra.Command {
	return &cobra.Command{
		Use:   "next",
		Short: "Take the oldest unread message and mark it read",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) != 0 {
				return &usageError{message: "usage: hopp inbox next [--mailbox <name>]"}
			}
			name, err := resolveMailbox(*mailbox)
			if err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Post(apiPath("v1", "mailboxes", name, "inbox", "next"), nil, &raw); err != nil {
				return err
			}
			// A drained inbox answers 204: no body to decode.
			if len(raw) == 0 {
				if flags.JSON {
					return printJSON(cmd, map[string]any{"unread": 0})
				}
				cmd.Println("inbox is empty")
				return nil
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var m inboxMessage
			if err := json.Unmarshal(raw, &m); err != nil {
				return err
			}
			printInboxMessage(cmd, m)
			return nil
		},
	}
}

// newInboxPeekCmd reads one message in full without marking it read.
func newInboxPeekCmd(mailbox *string) *cobra.Command {
	return &cobra.Command{
		Use:   "peek <msg-id>",
		Short: "Read one message in full without marking it read",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) != 1 {
				return &usageError{message: "usage: hopp inbox peek <msg-id> [--mailbox <name>]"}
			}
			id := strings.TrimPrefix(args[0], "#")
			if _, err := strconv.ParseInt(id, 10, 64); err != nil {
				return &usageError{message: "message id must be a number, e.g. hopp inbox peek 12"}
			}
			name, err := resolveMailbox(*mailbox)
			if err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var m inboxMessage
			if err := c.Get(apiPath("v1", "mailboxes", name, "inbox", id), nil, &m); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, m)
			}
			printInboxMessage(cmd, m)
			return nil
		},
	}
}

// resolveMailbox decides which mailbox a command reads: the flag, else the
// session the command runs in ($HOPP_SESSION_ID). Rocket also fell back to
// the name of the tmux session; a hopp session always has HOPP_SESSION_ID.
func resolveMailbox(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	if id := os.Getenv("HOPP_SESSION_ID"); id != "" {
		return id, nil
	}
	return "", &usageError{message: "which mailbox? pass --mailbox <name> (HOPP_SESSION_ID is unset outside a session)"}
}

func printInboxMessage(cmd *cobra.Command, m inboxMessage) {
	cmd.Printf("#%d from %s (%s, %s)\n", m.ID, dash(m.From), age(m.CreatedAt), m.Status)
	cmd.Println()
	cmd.Println(m.Body)
}

// firstLine returns the first line of body, shortened for a list view.
func firstLine(body string) string {
	line := body
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	// Counted in runes, not bytes: a Cyrillic question cut at byte 72 lands
	// mid-character and renders as garbage.
	const max = 72
	if r := []rune(line); len(r) > max {
		line = string(r[:max]) + "…"
	}
	return line
}

// age renders unix seconds as a compact age ("3m", "2h").
func age(ts int64) string {
	if ts == 0 {
		return "-"
	}
	d := time.Since(time.Unix(ts, 0))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
