package claudeinstance

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Each failed check names itself, so the daemon log can say why a hook
// update was rejected.
func TestValidateHookNamesTheFailedCheck(t *testing.T) {
	l, r, p := fixture()
	id := Resolve(context.Background(), l, nil, r, p, "/tmp/p").Identity
	now := time.Now()
	e := HookEvent{ClaudeSessionID: id.ClaudeSessionID, HookEventName: "SessionEnd", LaunchGeneration: l.Generation, ProducerPID: 12, ProducerStart: now, At: now.UnixNano()}
	for _, tc := range []struct {
		name, want string
		mutate     func(*HookEvent, *fakeProbe)
		state      string
	}{
		{"nested agent", "subagent", func(e *HookEvent, p *fakeProbe) { e.AgentID = "nested" }, "exited"},
		{"foreign UUID", "claude session id", func(e *HookEvent, p *fakeProbe) { e.ClaudeSessionID = "foreign" }, "exited"},
		{"old generation", "launch generation", func(e *HookEvent, p *fakeProbe) { e.LaunchGeneration = "old" }, "exited"},
		{"replay", "not newer", func(e *HookEvent, p *fakeProbe) { e.At = 1 }, "exited"},
		{"future", "time", func(e *HookEvent, p *fakeProbe) { e.At = now.Add(time.Minute).UnixNano() }, "exited"},
		{"no producer", "producer", func(e *HookEvent, p *fakeProbe) { e.ProducerPID = 0 }, "exited"},
		{"event mismatch", "event SessionEnd", func(e *HookEvent, p *fakeProbe) {}, "ready"},
		{"PID reused", "producer process", func(e *HookEvent, p *fakeProbe) { e.ProducerStart = now.Add(-time.Second) }, "exited"},
		{"nested process", "ancestry", func(e *HookEvent, p *fakeProbe) {
			p.processes[12] = Process{PID: 12, PPID: 11, Start: now, Name: "claude"}
		}, "exited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, p := fixture()
			p.processes[12] = Process{PID: 12, PPID: 11, Start: now, Name: "sh"}
			v := e
			tc.mutate(&v, &p)
			err := ValidateHook(context.Background(), id, v, tc.state, 1, now, p)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to name %q", err, tc.want)
			}
		})
	}
}

// A producer that is alive under the bound Claude passes; one that has
// exited by the time the daemon checks (the old command-substitution
// subshell) fails.
func TestValidateHookProducerMustBeAlive(t *testing.T) {
	l, r, p := fixture()
	id := Resolve(context.Background(), l, nil, r, p, "/tmp/p").Identity
	now := time.Now()
	p.processes[12] = Process{PID: 12, PPID: 11, Start: now, Name: "sh"}
	e := HookEvent{ClaudeSessionID: id.ClaudeSessionID, HookEventName: "Stop", LaunchGeneration: l.Generation, ProducerPID: 12, ProducerStart: now, At: now.UnixNano()}
	if err := ValidateHook(context.Background(), id, e, "ready", 0, now, p); err != nil {
		t.Fatalf("live hook shell under Claude refused: %v", err)
	}
	e.ProducerPID = 13 // exited: not in the process table
	err := ValidateHook(context.Background(), id, e, "ready", 0, now, p)
	if err == nil || !strings.Contains(err.Error(), "producer process missing") {
		t.Fatalf("exited producer: err = %v", err)
	}
}
