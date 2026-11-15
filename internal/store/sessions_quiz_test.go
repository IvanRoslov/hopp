package store

import "testing"

func TestPendingQuiz_SetReadClear(t *testing.T) {
	s := openTestStore(t)

	mustAddSession(t, s, "s1")

	// New session has no pending quiz.
	got, err := s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.PendingQuiz != "" {
		t.Fatalf("PendingQuiz initial = %q, want empty", got.PendingQuiz)
	}

	quizJSON := `{"questions":[{"question":"pick one","options":["a","b"]}]}`
	if err := s.SetPendingQuiz("s1", quizJSON); err != nil {
		t.Fatalf("SetPendingQuiz: %v", err)
	}

	got, err = s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession after set: %v", err)
	}
	if got.PendingQuiz != quizJSON {
		t.Fatalf("PendingQuiz = %q, want %q", got.PendingQuiz, quizJSON)
	}

	if err := s.ClearPendingQuiz("s1"); err != nil {
		t.Fatalf("ClearPendingQuiz: %v", err)
	}
	got, err = s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession after clear: %v", err)
	}
	if got.PendingQuiz != "" {
		t.Fatalf("PendingQuiz after clear = %q, want empty", got.PendingQuiz)
	}

	// ClearPendingQuiz is idempotent (no-op when already empty).
	if err := s.ClearPendingQuiz("s1"); err != nil {
		t.Fatalf("ClearPendingQuiz idempotent: %v", err)
	}

	if err := s.SetPendingQuiz("missing", quizJSON); err != ErrNotFound {
		t.Fatalf("SetPendingQuiz missing id: got %v, want ErrNotFound", err)
	}
	if err := s.ClearPendingQuiz("missing"); err != ErrNotFound {
		t.Fatalf("ClearPendingQuiz missing id: got %v, want ErrNotFound", err)
	}
}

func TestCompareAndSwapPendingQuiz(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")

	// NULL -> value.
	ok, err := s.CompareAndSwapPendingQuiz("s1", "", `{"a":1}`)
	if err != nil || !ok {
		t.Fatalf("swap from empty: ok=%v err=%v", ok, err)
	}
	// Mismatch: no change.
	ok, err = s.CompareAndSwapPendingQuiz("s1", "", `{"b":2}`)
	if err != nil || ok {
		t.Fatalf("swap with stale old: ok=%v err=%v, want false nil", ok, err)
	}
	if got, _ := s.GetSession("s1"); got.PendingQuiz != `{"a":1}` {
		t.Fatalf("pending = %q after failed swap", got.PendingQuiz)
	}
	// value -> NULL.
	ok, err = s.CompareAndSwapPendingQuiz("s1", `{"a":1}`, "")
	if err != nil || !ok {
		t.Fatalf("swap to empty: ok=%v err=%v", ok, err)
	}
	if got, _ := s.GetSession("s1"); got.PendingQuiz != "" {
		t.Fatalf("pending = %q, want empty", got.PendingQuiz)
	}
}
