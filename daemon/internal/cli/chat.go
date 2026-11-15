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
	"strings"
	"syscall"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// chatFollowInterval is how often `hopp chat --follow` asks for new entries.
// A package var so tests can shrink it.
var chatFollowInterval = 2 * time.Second

// chatEntry mirrors internal/api.chatEntryResponse.
type chatEntry struct {
	Role       string `json:"role"`
	Text       string `json:"text"`
	ToolName   string `json:"tool_name,omitempty"`
	TS         int64  `json:"ts"`
	Permission *struct {
		Title       string `json:"title"`
		AnswerLabel string `json:"answer_label"`
		AnsweredVia string `json:"answered_via"`
	} `json:"permission,omitempty"`
}

type chatPage struct {
	Entries []chatEntry `json:"entries"`
	Next    string      `json:"next_cursor"`
}

func newChatCmd() *cobra.Command {
	var limit int
	var follow bool
	cmd := &cobra.Command{
		Use:   "chat <session>",
		Short: "Show a session's conversation (and follow it with --follow)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			id := args[0]
			page, raw, err := fetchChat(c, id, "", limit)
			if err != nil {
				return err
			}
			if flags.JSON && !follow {
				return printRaw(cmd, raw)
			}
			w := cmd.OutOrStdout()
			printChat(w, page.Entries, flags.JSON)
			if !follow {
				return nil
			}
			return followChat(cmd.Context(), c, w, cmd.ErrOrStderr(), id, page.Next, limit)
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 0, "how many of the latest entries (the daemon's default when 0)")
	cmd.Flags().BoolVar(&follow, "follow", false, "keep printing new entries until Ctrl-C or the daemon stops")
	return cmd
}

func fetchChat(c *client.Client, id, cursor string, limit int) (chatPage, json.RawMessage, error) {
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := apiPath("v1", "sessions", id, "chat")
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var raw json.RawMessage
	if err := c.Get(path, nil, &raw); err != nil {
		return chatPage{}, nil, err
	}
	var page chatPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return chatPage{}, nil, err
	}
	return page, raw, nil
}

// followChat asks for the entries after cursor every chatFollowInterval until
// SIGINT/SIGTERM or ctx ends (exit 0). When a request fails because the
// daemon no longer answers, it says so on errW and returns nil, like
// `hopp events --follow`.
func followChat(ctx context.Context, c *client.Client, w, errW io.Writer, id, cursor string, limit int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	sigCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	ticker := time.NewTicker(chatFollowInterval)
	defer ticker.Stop()
	for {
		select {
		case <-sigCtx.Done():
			return nil
		case <-ticker.C:
			page, _, err := fetchChat(c, id, cursor, limit)
			if err != nil {
				if daemonGone(c) {
					fmt.Fprintln(errW, "hopp: the daemon stopped")
					return nil
				}
				return err
			}
			printChat(w, page.Entries, flags.JSON)
			if page.Next != "" {
				cursor = page.Next
			}
		}
	}
}

// printChat renders entries as JSON lines or as "<time> <role>: <text>",
// tools as "<time> tool <name>: <digest>", with continuation lines indented.
func printChat(w io.Writer, entries []chatEntry, asJSON bool) {
	for _, e := range entries {
		if asJSON {
			_ = json.NewEncoder(w).Encode(e)
			continue
		}
		at := "--:--:--"
		if e.TS > 0 {
			at = time.Unix(e.TS, 0).Format("15:04:05")
		}
		label := e.Role
		text := e.Text
		switch {
		case e.Role == "tool":
			label = "tool " + e.ToolName
		case e.Role == "permission" && e.Permission != nil:
			text = fmt.Sprintf("%s -> %s (%s)", e.Permission.Title, e.Permission.AnswerLabel, e.Permission.AnsweredVia)
		}
		lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
		fmt.Fprintf(w, "%s %s: %s\n", at, label, lines[0])
		for _, l := range lines[1:] {
			fmt.Fprintf(w, "  %s\n", l)
		}
	}
}
