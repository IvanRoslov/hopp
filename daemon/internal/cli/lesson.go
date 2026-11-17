package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// lessonView mirrors internal/api.lessonResponse.
type lessonView struct {
	ID        int64             `json:"id"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	Body      string            `json:"body"`
	Status    string            `json:"status"`
	CreatedAt int64             `json:"created_at"`
	ClosedAt  int64             `json:"closed_at"`
}

// newLessonCmd is `hopp lesson [text]`: record a note about what would make
// the harness better. The daemon only stores it.
func newLessonCmd() *cobra.Command {
	var file string
	var labels []string
	cmd := &cobra.Command{
		Use:   "lesson [text]",
		Short: "Record a lesson: a note on what would make the harness better",
		Long: "Stores a lesson and prints its id. The text comes from the argument, from -f/--file, or from stdin\n" +
			"(\"-\" as the argument or the file, or neither given with something piped in); empty text is refused. Inside a session the lesson carries that\n" +
			"session's id and labels; --label adds or overrides labels.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body, err := noteText(cmd, args, file, "lesson")
			if err != nil {
				return err
			}
			lbl, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			req := map[string]any{"body": body}
			if from := os.Getenv("HOPP_SESSION_ID"); from != "" {
				req["from"] = from
			}
			if lbl != nil {
				req["labels"] = lbl
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var l lessonView
			if err := c.Post("/v1/lessons", req, &l); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, l)
			}
			cmd.Println(l.ID)
			return nil
		},
	}
	cmd.Flags().StringVarP(&file, "file", "f", "", "read the text from this file")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "label key=value (repeatable)")
	return cmd
}

// noteText takes the text of a lesson or a post: the argument, the file,
// or a stdin that is piped in (see readBody).
func noteText(cmd *cobra.Command, args []string, file, noun string) (string, error) {
	arg := ""
	if len(args) == 1 {
		arg = args[0]
	}
	return readBody(cmd, arg, len(args) == 1, file, noun, true)
}

// newLessonsCmd is `hopp lessons`: list lessons (new ones unless --all or
// --closed), and `hopp lessons close <id>...`.
func newLessonsCmd() *cobra.Command {
	var all, closed bool
	var labels []string
	var from string
	cmd := &cobra.Command{
		Use:   "lessons",
		Short: "List lessons (new ones unless --all or --closed)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if all && closed {
				return &usageError{message: "--all and --closed exclude each other"}
			}
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			q := url.Values{}
			switch {
			case all:
				q.Set("status", "all")
			case closed:
				q.Set("status", "closed")
			}
			for _, l := range labels {
				q.Add("label", l)
			}
			if from != "" {
				q.Set("from", from)
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			path := "/v1/lessons"
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
				Lessons []lessonView `json:"lessons"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tAGE\tFROM\tLESSON")
			for _, l := range resp.Lessons {
				fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\n", l.ID, age(l.CreatedAt), dash(l.From), cutLine(l.Body, 80))
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.BoolVar(&all, "all", false, "include closed lessons")
	f.BoolVar(&closed, "closed", false, "only closed lessons")
	f.StringArrayVar(&labels, "label", nil, "only lessons with label key=value (repeatable)")
	f.StringVar(&from, "from", "", "only lessons from this session")
	cmd.AddCommand(newLessonsCloseCmd())
	return cmd
}

func newLessonsCloseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "close <id>...",
		Short: "Close lessons",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ids := make([]string, 0, len(args))
			for _, a := range args {
				id := strings.TrimPrefix(a, "#")
				if _, err := strconv.ParseInt(id, 10, 64); err != nil {
					return &usageError{message: "a lesson id is a number, got " + strconv.Quote(a)}
				}
				ids = append(ids, id)
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			for _, id := range ids {
				var l lessonView
				if err := c.Post(apiPath("v1", "lessons", id, "close"), nil, &l); err != nil {
					return err
				}
				cmd.Println(l.ID)
			}
			return nil
		},
	}
}

// cutLine returns the first line of body, cut at max runes.
func cutLine(body string, max int) string {
	line, _, _ := strings.Cut(body, "\n")
	if r := []rune(line); len(r) > max {
		line = string(r[:max]) + "…"
	}
	return line
}
