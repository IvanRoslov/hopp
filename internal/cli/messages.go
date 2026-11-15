package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// messageRow mirrors internal/api.messageResponse.
type messageRow struct {
	ID          int64  `json:"id"`
	From        string `json:"from,omitempty"`
	To          string `json:"to"`
	Body        string `json:"body"`
	Status      string `json:"status"`
	Attempts    int    `json:"attempts"`
	CreatedAt   int64  `json:"created_at"`
	DeliveredAt int64  `json:"delivered_at,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

func newMessagesCmd() *cobra.Command {
	var limit int
	cmd := &cobra.Command{
		Use:   "messages <session>",
		Short: "Show the messages to and from a session, oldest first",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			q := url.Values{}
			q.Set("session", args[0])
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/messages?"+q.Encode(), nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Messages []messageRow `json:"messages"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			for _, m := range resp.Messages {
				status := m.Status
				if m.Reason != "" {
					status += " (" + m.Reason + ")"
				}
				fmt.Fprintf(w, "#%d %s %s -> %s %s\n", m.ID, time.Unix(m.CreatedAt, 0).Format("2006-01-02 15:04:05"), dash(m.From), m.To, status)
				for _, line := range strings.Split(strings.TrimRight(m.Body, "\n"), "\n") {
					fmt.Fprintf(w, "  %s\n", line)
				}
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 0, "how many of the latest messages (the daemon's default when 0)")
	return cmd
}
