package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// printJSON writes v as indented JSON on stdout.
func printJSON(cmd *cobra.Command, v any) error {
	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// printRaw writes a JSON body the API returned, indented, on stdout.
func printRaw(cmd *cobra.Command, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return err
	}
	buf.WriteByte('\n')
	_, err := cmd.OutOrStdout().Write(buf.Bytes())
	return err
}

// parsePairs parses repeated key=value flag values. A value without "=" or
// with an empty key is a usage error naming the flag.
func parsePairs(flag string, values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(values))
	for _, v := range values {
		k, val, ok := strings.Cut(v, "=")
		if !ok || k == "" {
			return nil, &usageError{message: fmt.Sprintf("--%s wants key=value, got %q", flag, v)}
		}
		out[k] = val
	}
	return out, nil
}

// readFileFlag reads the file a flag names; "" means the flag was not given.
func readFileFlag(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// dash renders an empty table cell as "-".
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// stdinMarker is the conventional --file value meaning "read the body from
// stdin". It exists because the shell is the enemy here: a markdown body
// passed as a positional argument gets its backticks run as command
// substitution and its $words expanded, so an agent trying to send a code
// block loses exactly the content it was quoting. A pipe (or a file) never
// reaches the shell's parser.
const stdinMarker = "-"

// readTextInput reads a text body from path, treating stdinMarker as the
// command's stdin. Content is returned verbatim — no trimming — because
// trailing newlines are part of markdown and the caller may be sending a
// whole document.
func readTextInput(cmd *cobra.Command, path string) (string, error) {
	if path == stdinMarker {
		data, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return "", fmt.Errorf("read stdin: %w", err)
		}
		return string(data), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// stdinIsTerminal reports whether r is a terminal, i.e. nothing is piped
// in. Tests swap it.
var stdinIsTerminal = func(r io.Reader) bool {
	f, ok := r.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// readBody takes the text of a message, post, ask or lesson from exactly one
// source: the argument (arg, when hasArg), --file, or stdin. "-" as the
// argument or as --file means stdin. With no source, fallbackStdin reads a
// stdin that is piped in; otherwise it is a usage error. Every way of ending
// up with no text (a terminal on stdin, an empty pipe, a heredoc the shell
// did not pass on, a text of only spaces) is refused, never sent empty. The
// text is returned verbatim. noun names it in the errors.
func readBody(cmd *cobra.Command, arg string, hasArg bool, file, noun string, fallbackStdin bool) (string, error) {
	if hasArg && file != "" {
		return "", &usageError{message: "give the " + noun + " text as an argument or with --file, not both (for a pipe or a heredoc use --file - and no text argument)"}
	}
	fromStdin := (hasArg && arg == stdinMarker) || file == stdinMarker || (!hasArg && file == "" && fallbackStdin)
	var body string
	switch {
	case fromStdin:
		in := cmd.InOrStdin()
		if stdinIsTerminal(in) {
			if !hasArg && file == "" {
				return "", &usageError{message: "no " + noun + " text: give it as an argument, with --file <path>, or on stdin"}
			}
			return "", &usageError{message: "\"-\" reads the " + noun + " text from stdin, but nothing is piped in; write the text to a file and use --file <path>"}
		}
		b, err := io.ReadAll(in)
		if err != nil {
			return "", fmt.Errorf("read stdin: %w", err)
		}
		body = string(b)
		if strings.TrimSpace(body) == "" {
			return "", &usageError{message: "no " + noun + " text arrived on stdin (a heredoc or pipe your shell did not pass on?); write the text to a file and use --file <path>"}
		}
	case file != "":
		b, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		body = string(b)
	case hasArg:
		body = arg
	default:
		return "", &usageError{message: "no " + noun + " text: give it as an argument, with --file <path>, or with --file - and a pipe"}
	}
	if strings.TrimSpace(body) == "" {
		return "", &usageError{message: "the " + noun + " text is empty"}
	}
	return body, nil
}
