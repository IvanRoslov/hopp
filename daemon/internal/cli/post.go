package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// postView mirrors internal/api.postResponse.
type postView struct {
	ID          int64             `json:"id"`
	From        string            `json:"from"`
	Labels      map[string]string `json:"labels"`
	Body        string            `json:"body"`
	Attachments []string          `json:"attachments"`
	CreatedAt   int64             `json:"created_at"`
}

// newPostCmd is `hopp post [text]`: a note to the human that waits for no
// answer, or the human's own note.
func newPostCmd() *cobra.Command {
	var file, from string
	var labels, attach []string
	cmd := &cobra.Command{
		Use:   "post [text]",
		Short: "Post a note to the human that waits for no answer",
		Long: "Stores a post and prints its id. The text comes from the argument, from -f/--file, or from stdin\n" +
			"(\"-\" as the argument or the file, or neither given with something piped in); empty text is refused. The post is from $HOPP_SESSION_ID unless --from\n" +
			"names another session; --from \"\" makes it the human's own note. A post from a session carries that\n" +
			"session's labels; --label adds or overrides labels. --attach names a file path, a URL or an\n" +
			"artifact (name@version), stored as given.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body, err := noteText(cmd, args, file, "post")
			if err != nil {
				return err
			}
			lbl, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			if !cmd.Flags().Changed("from") {
				from = os.Getenv("HOPP_SESSION_ID")
			}
			req := map[string]any{"body": body}
			if from != "" {
				req["from"] = from
			}
			if lbl != nil {
				req["labels"] = lbl
			}
			if len(attach) > 0 {
				req["attachments"] = attach
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var p postView
			if err := c.Post("/v1/posts", req, &p); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, p)
			}
			cmd.Println(p.ID)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&file, "file", "f", "", "read the text from this file")
	f.StringArrayVar(&labels, "label", nil, "label key=value (repeatable)")
	f.StringArrayVar(&attach, "attach", nil, "a file path, URL or artifact name@version to show with the post (repeatable)")
	f.StringVar(&from, "from", "", `posting session (default: $HOPP_SESSION_ID; "" for the human)`)
	return cmd
}

// newPostsCmd is `hopp posts`: list posts, oldest first.
func newPostsCmd() *cobra.Command {
	var labels []string
	var from string
	var after int64
	var limit int
	cmd := &cobra.Command{
		Use:   "posts",
		Short: "List posts, oldest first",
		Long:  "Lists posts oldest first, at most 200 unless --limit says otherwise. --after <id> lists only newer posts.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			q := url.Values{}
			for _, l := range labels {
				q.Add("label", l)
			}
			if from != "" {
				q.Set("from", from)
			}
			if after > 0 {
				q.Set("after", strconv.FormatInt(after, 10))
			}
			if limit > 0 {
				q.Set("limit", strconv.Itoa(limit))
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			path := "/v1/posts"
			if enc := q.Encode(); enc != "" {
				path += "?" + enc
			}
			var raw json.RawMessage
			if err := c.Get(path, nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Posts []postView `json:"posts"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tAGE\tFROM\tATTACHED\tPOST")
			for _, p := range resp.Posts {
				fmt.Fprintf(tw, "#%d\t%s\t%s\t%d\t%s\n", p.ID, age(p.CreatedAt), dash(p.From), len(p.Attachments), cutLine(p.Body, 80))
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.StringArrayVar(&labels, "label", nil, "only posts with label key=value (repeatable)")
	f.StringVar(&from, "from", "", "only posts from this session")
	f.Int64Var(&after, "after", 0, "only posts with an id greater than this")
	f.IntVar(&limit, "limit", 0, "at most this many posts (default 200)")
	return cmd
}
