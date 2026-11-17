package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// askView mirrors internal/api.askResponse.
type askView struct {
	ID          int64             `json:"id"`
	From        string            `json:"from"`
	Labels      map[string]string `json:"labels"`
	Body        string            `json:"body"`
	Options     []string          `json:"options"`
	Attachments []string          `json:"attachments"`
	Status      string            `json:"status"`
	Choice      string            `json:"choice,omitempty"`
	Answer      string            `json:"answer,omitempty"`
	Reason      string            `json:"reason,omitempty"`
	CreatedAt   int64             `json:"created_at"`
}

// newAskCmd is `hopp ask "<text>"`: a session asks the human for a decision.
func newAskCmd() *cobra.Command {
	var options, labels, attach []string
	var from, file string
	var wait bool
	cmd := &cobra.Command{
		Use:   "ask (<text> | - | --file <path>)",
		Short: "Ask the human for a decision (from inside a session)",
		Long: "Creates a decision request and prints its id. --option offers choices; --label adds free key=value\n" +
			"context; --attach names files or URLs; --wait blocks until it is answered (exit 1 when withdrawn).\n" +
			"The question is the argument, a file (--file <path>), or stdin (\"-\" or --file -, only when piped in).",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			arg := ""
			if len(args) == 1 {
				arg = args[0]
			}
			text, err := readBody(cmd, arg, len(args) == 1, file, "question", false)
			if err != nil {
				return err
			}
			if from == "" {
				from = os.Getenv("HOPP_SESSION_ID")
			}
			if from == "" {
				return &usageError{message: "who is asking? run hopp ask inside a session, or pass --from <session>"}
			}
			lbl, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			body := map[string]any{"from": from, "body": text, "options": options, "labels": lbl, "attachments": attach}
			var a askView
			if err := c.Post("/v1/asks", body, &a); err != nil {
				return err
			}
			if !wait {
				if flags.JSON {
					return printJSON(cmd, a)
				}
				cmd.Printf("ask %d open\n", a.ID)
				return nil
			}
			if !flags.JSON {
				cmd.Printf("ask %d open, waiting for the answer\n", a.ID)
			}
			return waitForAsk(cmd, c, a.ID)
		},
	}
	f := cmd.Flags()
	f.StringArrayVar(&options, "option", nil, "a choice to offer (repeatable)")
	f.StringArrayVar(&labels, "label", nil, "free context key=value (repeatable)")
	f.StringArrayVar(&attach, "attach", nil, "a file path or URL to show with the ask (repeatable)")
	f.StringVar(&file, "file", "", "read the question from this file ('-' reads stdin)")
	f.StringVar(&from, "from", "", "asking session (default: $HOPP_SESSION_ID)")
	f.BoolVar(&wait, "wait", false, "block until the ask is answered or withdrawn")
	cmd.AddCommand(newAskWithdrawCmd())
	return cmd
}

// waitForAsk polls the ask every pollInterval (the `send --wait` interval)
// until it is closed. Answered prints the choice and answer; withdrawn is exit
// 1. When the daemon stops answering it says so and returns nil.
func waitForAsk(cmd *cobra.Command, c *client.Client, id int64) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for range ticker.C {
		var a askView
		if err := c.Get(apiPath("v1", "asks", strconv.FormatInt(id, 10)), nil, &a); err != nil {
			if daemonGone(c) {
				cmd.PrintErrln("hopp: the daemon stopped")
				return nil
			}
			return err
		}
		switch a.Status {
		case "open":
			continue
		case "answered":
			if flags.JSON {
				return printJSON(cmd, a)
			}
			if a.Choice != "" {
				cmd.Printf("answer: %s\n", a.Choice)
			}
			if a.Answer != "" {
				cmd.Println(a.Answer)
			}
			return nil
		default:
			if flags.JSON {
				_ = printJSON(cmd, a)
			} else {
				cmd.PrintErrf("ask %d %s: %s\n", id, a.Status, a.Reason)
			}
			return fmt.Errorf("ask %d was %s", id, a.Status)
		}
	}
	return nil
}

func newAskWithdrawCmd() *cobra.Command {
	var reason, from string
	cmd := &cobra.Command{
		Use:   "withdraw <ask-id>",
		Short: "Withdraw an open ask (only the asking session may)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimPrefix(args[0], "#")
			if _, err := strconv.ParseInt(id, 10, 64); err != nil {
				return &usageError{message: "ask id must be a number"}
			}
			if from == "" {
				from = os.Getenv("HOPP_SESSION_ID")
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var a askView
			if err := c.Post(apiPath("v1", "asks", id, "withdraw"), map[string]string{"from": from, "reason": reason}, &a); err != nil {
				return err
			}
			cmd.Printf("ask %d withdrawn\n", a.ID)
			return nil
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "why it is withdrawn")
	cmd.Flags().StringVar(&from, "from", "", "asking session (default: $HOPP_SESSION_ID)")
	return cmd
}

// newAsksCmd lists asks for the human.
// newAsksDismissCmd is `hopp asks dismiss <id>...`: the human closes asks
// that are no longer relevant, without an answer.
func newAsksDismissCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "dismiss <ask-id>...",
		Short: "Close asks that are no longer relevant, without an answer (the asker is told)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return &usageError{message: "usage: hopp asks dismiss <ask-id>..."}
			}
			ids := make([]string, 0, len(args))
			for _, a := range args {
				id := strings.TrimPrefix(a, "#")
				if _, err := strconv.ParseInt(id, 10, 64); err != nil {
					return &usageError{message: "an ask id is a number, got " + strconv.Quote(a)}
				}
				ids = append(ids, id)
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			for _, id := range ids {
				var a askView
				if err := c.Post(apiPath("v1", "asks", id, "dismiss"), nil, &a); err != nil {
					return err
				}
				cmd.Printf("ask %d dismissed\n", a.ID)
			}
			return nil
		},
	}
}

func newAsksCmd() *cobra.Command {
	var all bool
	var labels []string
	cmd := &cobra.Command{
		Use:   "asks",
		Short: "List decision requests (open ones unless --all)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			q := url.Values{}
			if all {
				q.Set("status", "all")
			}
			for _, l := range labels {
				q.Add("label", l)
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			path := "/v1/asks"
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
				Asks []askView `json:"asks"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			printAsks(cmd, resp.Asks)
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "include answered and withdrawn asks")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "only asks with label key=value (repeatable)")
	cmd.AddCommand(newAsksDismissCmd())
	return cmd
}

func printAsks(cmd *cobra.Command, asks []askView) {
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tFROM\tAGE\tSTATUS\tOPTIONS\tASK")
	for _, a := range asks {
		fmt.Fprintf(tw, "#%d\t%s\t%s\t%s\t%s\t%s\n", a.ID, dash(a.From), age(a.CreatedAt), a.Status, dash(strings.Join(a.Options, " / ")), firstLine(a.Body))
	}
	tw.Flush()
}

// newWaitingCmd prints everything that waits for the human.
func newWaitingCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "waiting",
		Short: "Everything waiting for the human: open asks and sessions' pending questions",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/waiting", nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Asks      []askView `json:"asks"`
				Questions []struct {
					Session  string        `json:"session"`
					Question *questionView `json:"question"`
				} `json:"questions"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			cmd.Printf("%d open ask(s) — answer with: hopp reply <id> [<choice>] [-m <text>]\n", len(resp.Asks))
			if len(resp.Asks) > 0 {
				printAsks(cmd, resp.Asks)
			}
			cmd.Printf("%d session question(s)\n", len(resp.Questions))
			for _, q := range resp.Questions {
				cmd.Printf("%s — answer with: hopp answer %s <choice>\n", q.Session, q.Session)
				if q.Question != nil {
					printQuestion(cmd.OutOrStdout(), q.Question)
				}
			}
			return nil
		},
	}
}

// newReplyCmd answers an ask: a choice by 1-based number or exact text,
// and/or -m text.
func newReplyCmd() *cobra.Command {
	var text string
	cmd := &cobra.Command{
		Use:   "reply <ask-id> [<choice>]",
		Short: "Answer an ask (choice by number or exact text, and/or -m text; -m alone when no option fits)",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimPrefix(args[0], "#")
			if _, err := strconv.ParseInt(id, 10, 64); err != nil {
				return &usageError{message: "ask id must be a number"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var a askView
			if err := c.Get(apiPath("v1", "asks", id), nil, &a); err != nil {
				return err
			}
			choice := ""
			if len(args) == 2 {
				choice, err = pickAskOption(a, args[1])
				if err != nil {
					return err
				}
			}
			if len(a.Options) > 0 && choice == "" && strings.TrimSpace(text) == "" {
				return &usageError{message: fmt.Sprintf("ask %s needs a choice (%s) or your own answer with -m <text>", id, numbered(a.Options))}
			}
			if len(a.Options) == 0 && strings.TrimSpace(text) == "" {
				return &usageError{message: fmt.Sprintf("ask %s has no options: answer with -m <text>", id)}
			}
			var out askView
			if err := c.Post(apiPath("v1", "asks", id, "answer"), map[string]string{"choice": choice, "answer": text}, &out); err != nil {
				return err
			}
			cmd.Printf("ask %d answered\n", out.ID)
			return nil
		},
	}
	cmd.Flags().StringVarP(&text, "message", "m", "", "answer text")
	return cmd
}

func pickAskOption(a askView, choice string) (string, error) {
	if len(a.Options) == 0 {
		return "", &usageError{message: "this ask has no options: answer with -m <text>"}
	}
	if n, err := strconv.Atoi(choice); err == nil && n >= 1 && n <= len(a.Options) {
		return a.Options[n-1], nil
	}
	for _, o := range a.Options {
		if o == choice {
			return o, nil
		}
	}
	return "", &usageError{message: fmt.Sprintf("no option %q; choose one of: %s", choice, numbered(a.Options))}
}

func numbered(options []string) string {
	out := make([]string, len(options))
	for i, o := range options {
		out[i] = fmt.Sprintf("%d. %s", i+1, o)
	}
	return strings.Join(out, "; ")
}
