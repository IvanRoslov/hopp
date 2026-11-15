package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/socketmsg"
)

// absentClaudeFixture is claudeStoreFixture for a root whose journal does not
// exist yet: the boundary is the absent sentinel (path known, Inode 0).
func absentClaudeFixture(t *testing.T, st *Store) (claudeinstance.Snapshot, int64) {
	t.Helper()
	v, id := claudeStoreFixture(t, st)
	path := filepath.Join(t.TempDir(), "proj", "absent.jsonl")
	v.Target.JournalPath = path
	if _, e := st.db.Exec(`DELETE FROM claude_launches WHERE session_id='s'`); e != nil {
		t.Fatal(e)
	}
	now := v.PreparedAt
	l := claudeinstance.Launch{HoppSessionID: "s", Generation: "g", PaneIdentity: v.Target.PaneIdentity, PanePID: 10, PaneStart: now, StartedAt: now}
	if e := st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	if ok, e := st.BindClaudeIdentity(v.Target); !ok || e != nil {
		t.Fatalf("bind %v %v", ok, e)
	}
	l2, _, e := st.GetClaudeLaunch("s")
	if e != nil {
		t.Fatal(e)
	}
	v.BindingRevision = l2.BindingRevision
	st.UpdateSessionActivity("s", "ready", time.Now().Unix())
	b, e := claudeinstance.PinJournalForSend(v.Target)
	if e != nil || b.Inode != 0 {
		t.Fatalf("absent pin %+v %v", b, e)
	}
	v.Boundary = b
	return v, id
}

// writeJournalRecord creates (or appends to) the journal with one exact
// incoming record and returns the proof FindProof would give for it.
func writeJournalRecord(t *testing.T, v claudeinstance.Snapshot, recordID string) claudeinstance.Proof {
	t.Helper()
	os.MkdirAll(filepath.Dir(v.Target.JournalPath), 0700)
	raw, _ := json.Marshal(map[string]any{"type": "user", "sessionId": v.Target.ClaudeSessionID, "uuid": recordID, "message": map[string]string{"role": "user", "content": v.Envelope}})
	f, e := os.OpenFile(v.Target.JournalPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		t.Fatal(e)
	}
	st, _ := f.Stat()
	f.Write(append(raw, '\n'))
	f.Close()
	sys := st.Sys().(*syscall.Stat_t)
	return claudeinstance.Proof{RecordID: recordID, Offset: st.Size(), End: st.Size() + int64(len(raw)) + 1, Device: uint64(sys.Dev), Inode: uint64(sys.Ino)}
}

func TestClaimAcceptsAbsentBoundary(t *testing.T) {
	st := openTestStore(t)
	v, id := absentClaudeFixture(t, st)
	for name, bad := range map[string]claudeinstance.JournalBoundary{
		"device without inode": {Path: v.Boundary.Path, Device: 5},
		"offset without inode": {Path: v.Boundary.Path, Offset: 3},
	} {
		w := v
		w.Boundary = bad
		if ok, _ := st.ClaimClaudeMessage(w); ok {
			t.Fatalf("%s accepted", name)
		}
	}
	if ok, e := st.ClaimClaudeMessage(v); !ok || e != nil {
		t.Fatalf("absent claim %v %v", ok, e)
	}
	got, e := st.GetClaudeDelivery(id)
	if e != nil || got.Boundary != v.Boundary {
		t.Fatalf("absent row round trip %+v %v", got.Boundary, e)
	}
}

func TestConfirmAbsentRecordsScannedInode(t *testing.T) {
	st := openTestStore(t)
	v, id := absentClaudeFixture(t, st)
	if ok, e := st.ClaimClaudeMessage(v); !ok || e != nil {
		t.Fatal(e)
	}
	p := writeJournalRecord(t, v, "record-a")
	if ok, e := st.ConfirmClaudeMessage(id, p, time.Now()); !ok || e != nil {
		t.Fatalf("confirm %v %v", ok, e)
	}
	var dev, ino int64
	if e := st.db.QueryRow(`SELECT device,inode FROM claude_consumed_records WHERE message_id=?`, id).Scan(&dev, &ino); e != nil {
		t.Fatal(e)
	}
	if uint64(dev) != p.Device || uint64(ino) != p.Inode || ino == 0 {
		t.Fatalf("consumed key %d/%d, want the scanned file %d/%d", dev, ino, p.Device, p.Inode)
	}
	m, _ := st.GetMessage(id)
	if m.Status != "delivered" {
		t.Fatalf("status %s", m.Status)
	}
}

func TestConfirmAbsentRequiresScannedFileIdentity(t *testing.T) {
	st := openTestStore(t)
	v, id := absentClaudeFixture(t, st)
	st.ClaimClaudeMessage(v)
	p := writeJournalRecord(t, v, "record-a")
	p.Device, p.Inode = 0, 0
	if ok, _ := st.ConfirmClaudeMessage(id, p, time.Now()); ok {
		t.Fatal("an absent-boundary proof without the scanned file confirmed")
	}
}

func TestConfirmRejectsFileReplacedBetweenScans(t *testing.T) {
	st := openTestStore(t)
	v, id := absentClaudeFixture(t, st)
	st.ClaimClaudeMessage(v)
	p := writeJournalRecord(t, v, "record-a")
	// Replace the file with another inode holding the same record.
	os.Rename(v.Target.JournalPath, v.Target.JournalPath+".old")
	q := writeJournalRecord(t, v, "record-a")
	if q.Inode == p.Inode {
		t.Skip("filesystem reused the inode")
	}
	if ok, _ := st.ConfirmClaudeMessage(id, p, time.Now()); ok {
		t.Fatal("proof from a replaced file confirmed")
	}
	m, _ := st.GetMessage(id)
	if m.Status == "delivered" {
		t.Fatal("delivered from a replaced file")
	}
}

func TestConfirmPinnedRequiresBoundaryInode(t *testing.T) {
	st := openTestStore(t)
	v, id := claudeStoreFixture(t, st)
	st.ClaimClaudeMessage(v)
	p := appendClaudeIncoming(t, v, "record-a")
	p.Device, p.Inode = v.Boundary.Device, v.Boundary.Inode+1
	if ok, _ := st.ConfirmClaudeMessage(id, p, time.Now()); ok {
		t.Fatal("pinned row confirmed with another file's identity")
	}
	p.Inode = v.Boundary.Inode
	if ok, e := st.ConfirmClaudeMessage(id, p, time.Now()); !ok || e != nil {
		t.Fatalf("pinned row with its own file %v %v", ok, e)
	}
}

func TestOnePhysicalRecordProvesOneAbsentMessage(t *testing.T) {
	st := openTestStore(t)
	a, idA := absentClaudeFixture(t, st)
	if ok, e := st.ClaimClaudeMessage(a); !ok || e != nil {
		t.Fatal(e)
	}
	b := a
	b.MessageID, _ = st.AddMessage(Message{ToSession: "s", Body: "feedback"})
	b.WireID, _ = socketmsg.NewMsgID()
	b.Envelope, _ = socketmsg.EnvelopeWithID(b.WireID, "", "", "feedback")
	if ok, e := st.ClaimClaudeMessage(b); !ok || e != nil {
		t.Fatalf("second absent claim %v %v", ok, e)
	}
	p := writeJournalRecord(t, a, "record-a")
	if ok, e := st.ConfirmClaudeMessage(idA, p, time.Now()); !ok || e != nil {
		t.Fatalf("confirm a %v %v", ok, e)
	}
	// b's envelope differs, so a's record can never prove b.
	if ok, _ := st.ConfirmClaudeMessage(b.MessageID, p, time.Now()); ok {
		t.Fatal("one record proved two messages")
	}
}

func TestAbsentUnresolvedBlocksPinnedClaim(t *testing.T) {
	st := openTestStore(t)
	a, idA := absentClaudeFixture(t, st)
	if ok, e := st.ClaimClaudeMessage(a); !ok || e != nil {
		t.Fatal(e)
	}
	p := writeJournalRecord(t, a, "record-a")
	b := a
	b.MessageID, _ = st.AddMessage(Message{ToSession: "s", Body: "feedback"})
	b.WireID, _ = socketmsg.NewMsgID()
	b.Envelope, _ = socketmsg.EnvelopeWithID(b.WireID, "", "", "feedback")
	var e error
	if b.Boundary, e = claudeinstance.PinJournalForSend(b.Target); e != nil || b.Boundary.Inode == 0 {
		t.Fatalf("pin existing %+v %v", b.Boundary, e)
	}
	if ok, _ := st.ClaimClaudeMessage(b); ok {
		t.Fatal("pinned claim allowed while an absent claim on the same uuid is unresolved")
	}
	if ok, e := st.ConfirmClaudeMessage(idA, p, time.Now()); !ok || e != nil {
		t.Fatalf("confirm a %v %v", ok, e)
	}
	if ok, e := st.ClaimClaudeMessage(b); !ok || e != nil {
		t.Fatalf("pinned claim after the absent one resolved %v %v", ok, e)
	}
}
