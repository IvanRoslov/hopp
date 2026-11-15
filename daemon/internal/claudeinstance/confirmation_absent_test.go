package claudeinstance

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// A root launched without a prompt has no journal until its first turn; the
// send path pins an "absent" boundary there (Inode 0), while PinJournal itself
// stays strict for the rebinding check in Resolve.

func TestPinJournalForSendAbsent(t *testing.T) {
	dir := t.TempDir()
	for _, path := range []string{
		filepath.Join(dir, "missing.jsonl"),
		filepath.Join(dir, "no-such-dir", "missing.jsonl"),
	} {
		b, e := PinJournalForSend(Identity{ClaudeSessionID: "target", JournalPath: path})
		if e != nil || b != (JournalBoundary{Path: path}) {
			t.Fatalf("absent %s: %+v %v", path, b, e)
		}
	}
}

func TestPinJournalForSendExistingEqualsPinJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "target.jsonl")
	if e := os.WriteFile(path, []byte("{}\n"), 0600); e != nil {
		t.Fatal(e)
	}
	id := Identity{ClaudeSessionID: "target", JournalPath: path}
	want, e := PinJournal(id)
	if e != nil {
		t.Fatal(e)
	}
	got, e := PinJournalForSend(id)
	if e != nil || got != want || got.Inode == 0 {
		t.Fatalf("existing journal: got %+v %v, want %+v", got, e, want)
	}
}

func TestPinJournalForSendRejectsWhatPinJournalRejects(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.jsonl")
	os.WriteFile(real, []byte("{}\n"), 0600)
	link := filepath.Join(dir, "link.jsonl")
	if e := os.Symlink(real, link); e != nil {
		t.Fatal(e)
	}
	sub := filepath.Join(dir, "adir.jsonl")
	os.Mkdir(sub, 0700)
	partial := filepath.Join(dir, "partial.jsonl")
	os.WriteFile(partial, []byte(`{"type":"user"`), 0600)
	for name, path := range map[string]string{"symlink": link, "directory": sub, "incomplete tail": partial} {
		if b, e := PinJournalForSend(Identity{ClaudeSessionID: "target", JournalPath: path}); e == nil {
			t.Fatalf("%s accepted: %+v", name, b)
		}
	}
}

func TestPinJournalStaysStrict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.jsonl")
	if b, e := PinJournal(Identity{ClaudeSessionID: "target", JournalPath: path}); e == nil {
		t.Fatalf("PinJournal accepted a missing journal: %+v", b)
	}
}

func absentSnapshot(path, envelope string) Snapshot {
	id := Identity{ClaudeSessionID: "target", JournalPath: path}
	return Snapshot{Target: id, Envelope: envelope, Boundary: JournalBoundary{Path: path}}
}

func TestFindProofAbsentNoFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "proj", "target.jsonl")
	p, ok, e := FindProof(context.Background(), absentSnapshot(path, "<cross-session-message>\nx\n</cross-session-message>"))
	if ok || e != nil {
		t.Fatalf("missing journal must wait, not prove or fail: %+v %v %v", p, ok, e)
	}
}

func fileIdentity(t *testing.T, path string) (uint64, uint64) {
	t.Helper()
	f, st, e := openJournal(path)
	if e != nil {
		t.Fatal(e)
	}
	f.Close()
	dev, ino, e := fileID(st)
	if e != nil {
		t.Fatal(e)
	}
	return dev, ino
}

func TestFindProofAbsentFileAppears(t *testing.T) {
	path := filepath.Join(t.TempDir(), "target.jsonl")
	env := "<cross-session-message>\nfeedback\n</cross-session-message>"
	s := absentSnapshot(path, env)
	os.WriteFile(path, nil, 0600)
	appendRecord(t, path, "user", "user", "target", "incoming", env)
	dev, ino := fileIdentity(t, path)
	p, ok, e := FindProof(context.Background(), s)
	if e != nil || !ok || p.RecordID != "incoming" || p.Offset != 0 || p.End <= 0 || p.Device != dev || p.Inode != ino {
		t.Fatalf("proof %+v %v %v (file %d/%d)", p, ok, e, dev, ino)
	}
}

func TestFindProofAbsentPreexistingRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "target.jsonl")
	env := "<cross-session-message>\nfeedback\n</cross-session-message>"
	s := absentSnapshot(path, env)
	os.WriteFile(path, nil, 0600)
	// Startup records and a human turn written before the envelope.
	raw, _ := json.Marshal(map[string]any{"type": "attachment", "sessionId": "target", "uuid": "hook", "attachment": map[string]any{"type": "hook_success"}})
	f, _ := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	f.Write(append(raw, '\n'))
	f.Close()
	appendRecord(t, path, "user", "user", "target", "human", "hello")
	appendRecord(t, path, "assistant", "assistant", "target", "reply", env)
	appendRecord(t, path, "user", "user", "target", "incoming", env)
	p, ok, e := FindProof(context.Background(), s)
	if e != nil || !ok || p.RecordID != "incoming" || p.Offset <= 0 {
		t.Fatalf("proof after earlier records: %+v %v %v", p, ok, e)
	}
	appendRecord(t, path, "user", "user", "target", "again", env)
	if _, ok, _ := FindProof(context.Background(), s); ok {
		t.Fatal("two consumptions of one envelope must stay ambiguous")
	}
}

func TestFindProofAbsentRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target.jsonl")
	real := filepath.Join(dir, "elsewhere.jsonl")
	env := "<cross-session-message>\nfeedback\n</cross-session-message>"
	os.WriteFile(real, nil, 0600)
	appendRecord(t, real, "user", "user", "target", "incoming", env)
	os.Symlink(real, path)
	if p, ok, e := FindProof(context.Background(), absentSnapshot(path, env)); ok || e == nil {
		t.Fatalf("symlinked journal accepted: %+v %v %v", p, ok, e)
	}
}
