package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
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

// followPollInterval is how often `hopp events --follow` polls for new
// events when it has fallen back to polling (SSE streaming unavailable).
const followPollInterval = 2 * time.Second

// eventFilter is what --session and --label narrow the output to.
type eventFilter struct {
	session string
	labels  map[string]string
	rawLbl  []string
}

func newEventsCmd() *cobra.Command {
	var session string
	var limit int
	var follow bool
	var labels []string
	cmd := &cobra.Command{
		Use:   "events",
		Short: "Show the latest events (and follow new ones with --follow)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			lbl, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			f := eventFilter{session: session, labels: lbl, rawLbl: labels}
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
			if flags.JSON && !follow && len(lbl) == 0 {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Events []eventRow `json:"events"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			printEvents(w, f.keep(resp.Events), flags.JSON)
			if !follow {
				return nil
			}
			var lastID int64
			if n := len(resp.Events); n > 0 {
				lastID = resp.Events[n-1].ID
			}
			return followEvents(cmd.Context(), c, w, cmd.ErrOrStderr(), f, lastID)
		},
	}
	cmd.Flags().StringVar(&session, "session", "", "only events of this session")
	cmd.Flags().IntVar(&limit, "limit", 50, "how many of the latest events")
	cmd.Flags().BoolVar(&follow, "follow", false, "keep printing new events until Ctrl-C or the daemon stops")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "only events of sessions with this label (k=v, repeatable)")
	return cmd
}

// keep returns the events that carry every wanted label. The daemon puts a
// session's labels into each event's data under "labels".
func (f eventFilter) keep(events []eventRow) []eventRow {
	if len(f.labels) == 0 {
		return events
	}
	var out []eventRow
	for _, e := range events {
		got, _ := e.Data["labels"].(map[string]any)
		ok := true
		for k, v := range f.labels {
			if s, has := got[k].(string); !has || s != v {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, e)
		}
	}
	return out
}

// followEvents streams new events (id > lastID) to w until interrupted by
// SIGINT/SIGTERM or ctx is cancelled, at which point it returns nil (a
// clean exit). It tries SSE (GET /v1/events/stream) first; if that
// connection cannot be established (or drops), it falls back to polling
// GET /v1/events every followPollInterval, picking up from wherever the SSE
// attempt left off. When the stream or a poll fails because the daemon no
// longer answers, that is the end of the events: it says so on errW and
// returns nil.
func followEvents(ctx context.Context, c *client.Client, w, errW io.Writer, f eventFilter, lastID int64) error {
	if ctx == nil {
		ctx = context.Background()
	}
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	newLastID, err := followEventsSSE(sigCtx, c, w, f, lastID)
	if err == nil || sigCtx.Err() != nil {
		return nil
	}
	if daemonGone(c) {
		fmt.Fprintln(errW, "hopp: the daemon stopped")
		return nil
	}
	err = followEventsPoll(sigCtx, c, w, f, newLastID)
	if err != nil && daemonGone(c) {
		fmt.Fprintln(errW, "hopp: the daemon stopped")
		return nil
	}
	return err
}

// daemonGone reports whether the daemon no longer answers its health check.
func daemonGone(c *client.Client) bool {
	var health map[string]any
	return c.Get("/v1/health", nil, &health) != nil
}

// followEventsSSE connects to GET /v1/events/stream?since=<lastID> and
// prints events as they arrive. It returns the id of the last event
// printed (so a caller falling back to polling can resume from there) and
// any error that ended the stream (nil on a clean ctx cancellation).
func followEventsSSE(ctx context.Context, c *client.Client, w io.Writer, f eventFilter, lastID int64) (int64, error) {
	q := url.Values{}
	q.Set("since", fmt.Sprintf("%d", lastID))
	if f.session != "" {
		q.Set("session", f.session)
	}
	for _, l := range f.rawLbl {
		q.Add("label", l)
	}

	err := c.Stream(ctx, "/v1/events/stream?"+q.Encode(), func(id int64, event, data string) error {
		var payload eventRow
		if jsonErr := json.Unmarshal([]byte(data), &payload); jsonErr != nil {
			// Malformed frame (or a comment slipping through) — skip it
			// rather than aborting the whole stream.
			return nil
		}
		printEvents(w, []eventRow{payload}, flags.JSON)
		lastID = payload.ID
		return nil
	})
	return lastID, err
}

// followEventsPoll polls the daemon for new events (id > lastID) every
// followPollInterval until interrupted (ctx done), at which point it
// returns nil (a clean exit).
func followEventsPoll(ctx context.Context, c *client.Client, w io.Writer, f eventFilter, lastID int64) error {
	ticker := time.NewTicker(followPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			q := url.Values{}
			q.Set("since", fmt.Sprintf("%d", lastID))
			if f.session != "" {
				q.Set("session", f.session)
			}
			var resp struct {
				Events []eventRow `json:"events"`
			}
			if err := c.Get("/v1/events?"+q.Encode(), nil, &resp); err != nil {
				return err
			}
			if len(resp.Events) == 0 {
				continue
			}
			printEvents(w, f.keep(resp.Events), flags.JSON)
			lastID = resp.Events[len(resp.Events)-1].ID
		}
	}
}

// printEvents renders events either as JSON lines or as
// "<id> <local time> <type> <session or -> [<compact json data>]".
func printEvents(w io.Writer, events []eventRow, asJSON bool) {
	for _, e := range events {
		if asJSON {
			_ = json.NewEncoder(w).Encode(e)
			continue
		}
		data := ""
		if len(e.Data) > 0 {
			b, _ := json.Marshal(e.Data)
			data = " " + string(b)
		}
		fmt.Fprintf(w, "%d %s %s %s%s\n", e.ID, time.Unix(e.TS, 0).Format("2006-01-02 15:04:05"), e.Type, dash(e.SessionID), data)
	}
}
