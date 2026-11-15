package session

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

func addEnded(t *testing.T, e testEnv, id, parent, state string) {
	t.Helper()
	if err := e.st.AddSession(store.Session{ID: id, ParentID: parent, WorktreePath: t.TempDir(), TmuxName: id, Agent: "fake", State: state}); err != nil {
		t.Fatal(err)
	}
}

func exists(t *testing.T, st *store.Store, id string) bool {
	t.Helper()
	_, err := st.GetSession(id)
	return err == nil
}

func TestRemoveRefusesLive(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "live", "", t.TempDir())
	removed, err := e.m.Remove(context.Background(), "live", false)
	if validationCode(err) != "session_live" || removed != nil || !exists(t, e.st, "live") {
		t.Fatalf("Remove(live) = %v, %v", removed, err)
	}
	if _, err := e.m.Remove(context.Background(), "nosuch", false); validationCode(err) != "session_not_found" {
		t.Fatalf("Remove(nosuch) = %v", err)
	}
}

func TestRemoveRefusesChildrenWithoutRecursive(t *testing.T) {
	e := testManager(t)
	addEnded(t, e, "p", "", "killed")
	addEnded(t, e, "c", "p", "done")
	if _, err := e.m.Remove(context.Background(), "p", false); validationCode(err) != "session_has_children" {
		t.Fatalf("err = %v, want session_has_children", err)
	}
	if !exists(t, e.st, "p") || !exists(t, e.st, "c") {
		t.Fatal("something was deleted")
	}
}

// Review Focus 4: one live descendant anywhere refuses the whole removal.
func TestRemoveRecursiveRefusesLiveDescendantAndDeletesNothing(t *testing.T) {
	e := testManager(t)
	addEnded(t, e, "p", "", "killed")
	addEnded(t, e, "c", "p", "errored")
	addLiveSession(t, e, "g", "c", t.TempDir())
	_, err := e.m.Remove(context.Background(), "p", true)
	if validationCode(err) != "session_live" {
		t.Fatalf("err = %v, want session_live", err)
	}
	var ve *ValidationError
	if !errors.As(err, &ve) || !strings.Contains(ve.Message, `"g"`) {
		t.Errorf("message %q should name the live session g", err)
	}
	for _, id := range []string{"p", "c", "g"} {
		if !exists(t, e.st, id) {
			t.Errorf("%s was deleted", id)
		}
	}
}

func TestRemoveRecursiveRemovesSubtree(t *testing.T) {
	e := testManager(t)
	addEnded(t, e, "p", "", "killed")
	addEnded(t, e, "c1", "p", "done")
	addEnded(t, e, "c2", "p", "errored")
	addEnded(t, e, "g", "c1", "killed")
	addEnded(t, e, "other", "", "killed")
	removed, err := e.m.Remove(context.Background(), "p", true)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(removed)
	if !reflect.DeepEqual(removed, []string{"c1", "c2", "g", "p"}) {
		t.Errorf("removed = %v", removed)
	}
	for _, id := range removed {
		if exists(t, e.st, id) {
			t.Errorf("%s still there", id)
		}
	}
	if !exists(t, e.st, "other") {
		t.Error("an unrelated session was removed")
	}
	if len(e.rt.Destroyed) != 0 {
		t.Errorf("Remove touched tmux: %v", e.rt.Destroyed)
	}
	// A child alone can be removed too, keeping its parent.
	addEnded(t, e, "q", "", "killed")
	addEnded(t, e, "qc", "q", "killed")
	if removed, err := e.m.Remove(context.Background(), "qc", false); err != nil || len(removed) != 1 || !exists(t, e.st, "q") {
		t.Fatalf("Remove(child) = %v, %v", removed, err)
	}
}

func TestRemoveRefusesPendingDelivery(t *testing.T) {
	for _, status := range []string{"queued", "delivering", "accepted"} {
		e := testManager(t)
		addEnded(t, e, "p", "", "killed")
		addEnded(t, e, "c", "p", "killed")
		id, _ := e.st.AddMessage(store.Message{ToSession: "c", Body: "x"})
		if status != "queued" {
			e.st.UpdateMessageStatus(id, status, 1, 0, "")
		}
		if _, err := e.m.Remove(context.Background(), "p", true); validationCode(err) != "session_delivery_pending" {
			t.Fatalf("%s: err = %v, want session_delivery_pending", status, err)
		}
		if !exists(t, e.st, "c") {
			t.Fatalf("%s: deleted", status)
		}
		e.st.UpdateMessageStatus(id, "failed", 1, 0, "recipient_gone")
		if _, err := e.m.Remove(context.Background(), "p", true); err != nil {
			t.Fatalf("%s: after the message settled: %v", status, err)
		}
	}
}

func TestRemovedIDCanBeUsedAgain(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	if _, err := e.m.Spawn(context.Background(), SpawnReq{ID: "again", Dir: dir, Profile: fakeProfile()}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Kill(context.Background(), "again", "killed"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Spawn(context.Background(), SpawnReq{ID: "again", Dir: dir, Profile: fakeProfile()}); validationCode(err) != "session_exists" {
		t.Fatalf("before removal: %v, want session_exists", err)
	}
	if _, err := e.m.Remove(context.Background(), "again", false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Spawn(context.Background(), SpawnReq{ID: "again", Dir: dir, Profile: fakeProfile()}); err != nil {
		t.Fatalf("after removal: %v", err)
	}
}
