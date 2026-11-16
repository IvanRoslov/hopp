package cli

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/api"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

// realAPI serves the daemon's real handler, on a temp store, on a socket the
// CLI can be pointed at; it returns a fakeAPI value holding only that socket.
func realAPI(t *testing.T) (*fakeAPI, *store.Store) {
	t.Helper()
	dir, err := os.MkdirTemp("", "hcli")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	home := t.TempDir()
	st, err := store.Open(filepath.Join(home, "hopp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sock := filepath.Join(dir, "hopp.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: api.NewHandler(api.Deps{Store: st, Cfg: &config.Config{Home: home}, Shutdown: func() {}, StartedAt: time.Now()})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	flags = globalFlags{}
	t.Setenv("HOPP_SESSION_ID", "")
	t.Setenv("HOPP_HOME", t.TempDir())
	return &fakeAPI{sock: sock}, st
}

// TestReplyChoiceWithTextThroughTheAPI: hopp reply with a choice and -m
// text against the real API stores both, and hopp asks --all --label finds
// the answered ask again.
func TestReplyChoiceWithTextThroughTheAPI(t *testing.T) {
	f, st := realAPI(t)
	id, err := st.AddAsk(store.Ask{Body: "Accept?", Options: []string{"Accept", "Return"}, Labels: map[string]string{"kind": "review"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, errOut, code := runCLI(t, f, "reply", "#"+strconv.FormatInt(id, 10), "2", "-m", "fix the header"); code != 0 {
		t.Fatalf("reply: exit %d: %s", code, errOut)
	}
	a, err := st.GetAsk(id)
	if err != nil || a.Status != store.AskAnswered || a.Choice != "Return" || a.Answer != "fix the header" {
		t.Fatalf("stored ask = %+v, %v", a, err)
	}
	out, errOut, code := runCLI(t, f, "--json", "asks", "--all", "--label", "kind=review")
	if code != 0 {
		t.Fatalf("asks: exit %d: %s", code, errOut)
	}
	var resp struct {
		Asks []askView `json:"asks"`
	}
	if err := json.Unmarshal([]byte(out), &resp); err != nil || len(resp.Asks) != 1 || resp.Asks[0].Choice != "Return" || resp.Asks[0].Answer != "fix the header" {
		t.Errorf("asks --all --label = %q (%v)", out, err)
	}
}
