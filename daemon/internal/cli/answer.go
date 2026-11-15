package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// questionView mirrors internal/api.quizResponse, the "question" field of
// the session JSON.
type questionView struct {
	Questions []struct {
		Question    string `json:"question"`
		Header      string `json:"header"`
		MultiSelect bool   `json:"multi_select"`
		Options     []struct {
			Label       string `json:"label"`
			Description string `json:"description,omitempty"`
		} `json:"options"`
	} `json:"questions"`
	Source string `json:"source,omitempty"`
	Raw    string `json:"raw,omitempty"`
}

// answerItem is one entry of the answer body (rocket's quizAnswerRequest).
type answerItem struct {
	QuestionIndex int    `json:"question_index"`
	OptionIndices []int  `json:"option_indices,omitempty"`
	Text          string `json:"text,omitempty"`
}

func newAnswerCmd() *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "answer <session> [<choice>]",
		Short: "Show or answer the question a session waits on",
		Long: "Without a choice, prints the pending question and its options. With one, answers a single question by\n" +
			"option number (1-based) or exact label. --file sends a full answer body ({\"answers\":[...]}) for any question.",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := args[0]
			if file != "" && len(args) == 2 {
				return &usageError{message: "usage: hopp answer <session> [<choice> | --file <path>]"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var body any
			if file != "" {
				text, err := readTextInput(cmd, file)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				if err := json.Unmarshal([]byte(text), &raw); err != nil {
					return &usageError{message: fmt.Sprintf("--file is not JSON: %v", err)}
				}
				body = raw
			} else {
				var sess struct {
					Question *questionView `json:"question"`
				}
				if err := c.Get(apiPath("v1", "sessions", id), nil, &sess); err != nil {
					return err
				}
				w := cmd.OutOrStdout()
				if sess.Question == nil || len(sess.Question.Questions) == 0 {
					if len(args) == 2 {
						return fmt.Errorf("%s has no pending question; nothing was answered", id)
					}
					fmt.Fprintf(w, "%s has no pending question\n", id)
					return nil
				}
				if len(args) == 1 {
					printQuestion(w, sess.Question)
					return nil
				}
				if len(sess.Question.Questions) != 1 {
					printQuestion(w, sess.Question)
					return &usageError{message: "this question has several parts: answer it with --file <answers.json>"}
				}
				idx, err := pickOption(sess.Question, args[1])
				if err != nil {
					return err
				}
				body = map[string]any{"answers": []answerItem{{QuestionIndex: 0, OptionIndices: []int{idx}}}}
			}
			var resp json.RawMessage
			if err := c.Post(apiPath("v1", "sessions", id, "quiz", "answer"), body, &resp); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, resp)
			}
			cmd.Printf("answering %s (the session clears the question once the keys land)\n", id)
			return nil
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "file with the full answer body ('-' reads stdin)")
	return cmd
}

// pickOption maps a 1-based option number or an exact option label to the
// 0-based option index the API takes.
func pickOption(q *questionView, choice string) (int, error) {
	opts := q.Questions[0].Options
	if n, err := strconv.Atoi(choice); err == nil {
		if n >= 1 && n <= len(opts) {
			return n - 1, nil
		}
	} else {
		for i, o := range opts {
			if o.Label == choice {
				return i, nil
			}
		}
	}
	labels := make([]string, len(opts))
	for i, o := range opts {
		labels[i] = fmt.Sprintf("%d. %s", i+1, o.Label)
	}
	return 0, &usageError{message: fmt.Sprintf("no option %q; choose one of: %s", choice, strings.Join(labels, "; "))}
}

// printQuestion prints each question with its header and numbered options.
func printQuestion(w io.Writer, q *questionView) {
	for i, qq := range q.Questions {
		if len(q.Questions) > 1 {
			fmt.Fprintf(w, "[%d] ", i+1)
		}
		if qq.Header != "" {
			fmt.Fprintf(w, "%s: %s\n", qq.Header, qq.Question)
		} else {
			fmt.Fprintln(w, qq.Question)
		}
		for j, o := range qq.Options {
			if o.Description != "" {
				fmt.Fprintf(w, "  %d. %s — %s\n", j+1, o.Label, o.Description)
			} else {
				fmt.Fprintf(w, "  %d. %s\n", j+1, o.Label)
			}
		}
		if len(qq.Options) == 0 && q.Raw != "" {
			fmt.Fprintln(w, q.Raw)
		}
	}
}
