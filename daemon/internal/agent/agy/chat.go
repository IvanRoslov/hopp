package agy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/IvanRoslov/hopp/internal/agent"
)

const chatDigestMaxRunes = 120

func chatDigest(raw string) string {
	text := strings.Join(strings.Fields(raw), " ")
	runes := []rune(text)
	if len(runes) <= chatDigestMaxRunes {
		return text
	}
	return string(runes[:chatDigestMaxRunes-1]) + "…"
}

// argText returns a tool argument as plain text. agy stores every argument
// as a JSON string that itself holds JSON ("\"sleep 20\""), so it is decoded
// twice when it can be.
func argText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return string(raw)
	}
	var inner string
	if json.Unmarshal([]byte(s), &inner) == nil {
		return inner
	}
	return s
}

// toolDigest is the short line shown for a tool call: the command of a
// run_command, else the arguments as «name=value» in name order. agy's own
// toolSummary argument is a description of the call, not an input.
func toolDigest(args map[string]json.RawMessage) string {
	if cmd, ok := args["CommandLine"]; ok {
		return chatDigest(argText(cmd))
	}
	names := make([]string, 0, len(args))
	for name := range args {
		if name != "toolSummary" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var b bytes.Buffer
	for i, name := range names {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(name + "=" + argText(args[name]))
	}
	return chatDigest(b.String())
}

// chatEntries turns one journal record into chat entries: the user's text,
// the model's reply, and one entry per tool call. Tool results and agy's own
// notices are not chat.
func chatEntries(rec record) []agent.ChatEntry {
	var ts int64
	if at := rec.at(); !at.IsZero() {
		ts = at.Unix()
	}
	switch rec.Type {
	case typeUserInput:
		if text := rec.userText(); text != "" {
			return []agent.ChatEntry{{Role: "user", Text: text, TS: ts}}
		}
	case typePlannerResponse:
		var out []agent.ChatEntry
		if strings.TrimSpace(rec.Content) != "" {
			out = append(out, agent.ChatEntry{Role: "assistant", Text: rec.Content, TS: ts})
		}
		for _, call := range rec.ToolCalls {
			if call.Name != "" {
				out = append(out, agent.ChatEntry{Role: "tool", ToolName: call.Name, Text: toolDigest(call.Args), TS: ts})
			}
		}
		return out
	}
	return nil
}

// TranscriptTail implements agent.Agent. The cursor is «<journal path>:<last
// step index read>»; a cursor of another conversation starts from the top.
func (a *Agy) TranscriptTail(ctx context.Context, ref agent.ActivityRef, cursor string) ([]agent.ChatEntry, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	path, _, err := findTranscript(ref.WorktreePath, ref.Since)
	if err != nil {
		return nil, "", err
	}
	after := int64(-1)
	if idx := strings.LastIndex(cursor, ":"); idx >= 0 && cursor[:idx] == path {
		if parsed, err := strconv.ParseInt(cursor[idx+1:], 10, 64); err == nil {
			after = parsed
		}
	}
	var entries []agent.ChatEntry
	last := after
	if err := scan(path, func(rec record) bool {
		if rec.StepIndex > after {
			entries = append(entries, chatEntries(rec)...)
			if rec.StepIndex > last {
				last = rec.StepIndex
			}
		}
		return ctx.Err() == nil
	}); err != nil {
		return nil, "", fmt.Errorf("read agy chat %s: %w", path, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	return entries, fmt.Sprintf("%s:%d", path, last), nil
}

// TranscriptStat implements agent.Agent.
func (a *Agy) TranscriptStat(ctx context.Context, ref agent.ActivityRef) (int64, int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, 0, err
	}
	_, info, err := findTranscript(ref.WorktreePath, ref.Since)
	if err != nil {
		return 0, 0, err
	}
	return info.ModTime().Unix(), info.Size(), nil
}
