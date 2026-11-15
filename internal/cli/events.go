package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/spf13/cobra"
)

// eventRow is the subset of the API's event JSON shape needed to render
// `hopp events`. Field names/tags mirror internal/api.eventResponse.
type eventRow struct {
	ID        int64          `json:"id"`
	TS        int64          `json:"ts"`
	Type      string         `json:"type"`
	SessionID string         `json:"session_id,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
}

func newEventsCmd() *cobra.Command {
	var session string
	var limit int
	cmd := &cobra.Command{
		Use:   "events",
		Short: "Show the latest events",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			q := url.Values{}
			q.Set("limit", strconv.Itoa(limit))
			if session != "" {
				q.Set("session", session)
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/events?"+q.Encode(), nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Events []eventRow `json:"events"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			for _, e := range resp.Events {
				data := ""
				if len(e.Data) > 0 {
					b, _ := json.Marshal(e.Data)
					data = " " + string(b)
				}
				fmt.Fprintf(w, "%d %s %s %s%s\n", e.ID, time.Unix(e.TS, 0).Format("2006-01-02 15:04:05"), e.Type, dash(e.SessionID), data)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&session, "session", "", "only events of this session")
	cmd.Flags().IntVar(&limit, "limit", 50, "how many of the latest events")
	return cmd
}
