package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hopp.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// mustAddSession adds a minimal live session with the given id.
func mustAddSession(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.AddSession(Session{ID: id, WorktreePath: "/wt/" + id, TmuxName: id, Agent: "claude-code", State: "running"}); err != nil {
		t.Fatalf("AddSession %s: %v", id, err)
	}
}

func TestOpen_ReopenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hopp.db")

	s1, err := Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	mustAddSession(t, s1, "s1")
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer s2.Close()

	got, err := s2.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession after reopen: %v", err)
	}
	if got.WorktreePath != "/wt/s1" {
		t.Fatalf("WorktreePath = %q, want /wt/s1", got.WorktreePath)
	}
}

func TestOpen_PragmasOnFreshConnections(t *testing.T) {
	s := openTestStore(t)

	ctx := context.Background()

	// Get two concurrent connections from the pool
	conn1, err := s.db.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn 1: %v", err)
	}
	defer conn1.Close()

	conn2, err := s.db.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn 2: %v", err)
	}
	defer conn2.Close()

	// Verify foreign_keys pragma is set on both connections
	var fkEnabled1 int
	if err := conn1.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fkEnabled1); err != nil {
		t.Fatalf("Query PRAGMA foreign_keys on conn1: %v", err)
	}
	if fkEnabled1 != 1 {
		t.Fatalf("foreign_keys on conn1 = %d, want 1", fkEnabled1)
	}

	var fkEnabled2 int
	if err := conn2.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fkEnabled2); err != nil {
		t.Fatalf("Query PRAGMA foreign_keys on conn2: %v", err)
	}
	if fkEnabled2 != 1 {
		t.Fatalf("foreign_keys on conn2 = %d, want 1", fkEnabled2)
	}
}

func TestOpen_EscapedDSNPath(t *testing.T) {
	// Test that paths containing special characters like '?', '#', and '%'
	// are properly escaped so pragmas are preserved in the DSN.
	oddDir := filepath.Join(t.TempDir(), "we?ird#50%")
	if err := os.Mkdir(oddDir, 0755); err != nil {
		t.Fatalf("mkdir oddDir: %v", err)
	}

	path := filepath.Join(oddDir, "hopp.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open with escaped path: %v", err)
	}
	defer s.Close()

	// Verify that pragmas were successfully applied by checking foreign_keys
	ctx := context.Background()
	var fkEnabled int
	if err := s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fkEnabled); err != nil {
		t.Fatalf("Query PRAGMA foreign_keys: %v", err)
	}
	if fkEnabled != 1 {
		t.Fatalf("foreign_keys = %d, want 1 (pragma was not applied)", fkEnabled)
	}
}

// TestOpenBoundsThePool: an unbounded pool let a burst of requests open
// hundreds of SQLite connections, each with its own page cache, until the
// daemon drowned in memory and contention. Bounded, extra queries wait in
// line for a connection instead.
func TestOpenBoundsThePool(t *testing.T) {
	s := openTestStore(t)
	if got := s.db.Stats().MaxOpenConnections; got != maxOpenConns {
		t.Fatalf("MaxOpenConnections = %d, want %d", got, maxOpenConns)
	}
}
