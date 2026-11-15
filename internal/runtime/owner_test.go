package runtime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os/exec"
	"testing"
)

func TestSessionEnv(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not on PATH")
	}
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	name := "hopp-test-owner-" + hex.EncodeToString(b)
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", name, "-e", "HOPP_SESSION_ID="+name, "sleep 30").CombinedOutput(); err != nil {
		t.Fatalf("new-session: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("tmux", "kill-session", "-t", "="+name).Run() })

	ctx := context.Background()
	if v, ok, err := SessionEnv(ctx, name, "HOPP_SESSION_ID"); err != nil || !ok || v != name {
		t.Errorf("SessionEnv(HOPP_SESSION_ID) = %q, %v, %v; want %q, true, nil", v, ok, err, name)
	}
	if v, ok, err := SessionEnv(ctx, name, "HOPP_NO_SUCH_KEY"); err != nil || ok {
		t.Errorf("missing key = %q, %v, %v; want false, nil", v, ok, err)
	}
	if v, ok, err := SessionEnv(ctx, name+"-missing", "HOPP_SESSION_ID"); err != nil || ok {
		t.Errorf("missing session = %q, %v, %v; want false, nil", v, ok, err)
	}
	// An exact-match target: a prefix of a live name is not that session.
	if _, ok, err := SessionEnv(ctx, name[:len(name)-2], "HOPP_SESSION_ID"); err != nil || ok {
		t.Errorf("prefix name matched: ok=%v err=%v", ok, err)
	}
}
