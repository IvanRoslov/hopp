package session

import (
	"context"
	"errors"
	"github.com/IvanRoslov/hopp/internal/session/sessiontest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

func mkdir(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestSpawnRunsAgentInDir(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	sess, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile()})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if sess.State != "running" || sess.TmuxName != sess.ID {
		t.Errorf("session = %+v, want running with tmux name = id", sess)
	}
	got, err := e.st.GetSession(sess.ID)
	if err != nil || got.State != "running" {
		t.Fatalf("stored = %+v, %v", got, err)
	}
	if len(e.rt.Created) != 1 || e.rt.Created[0].Name != sess.ID || e.rt.Created[0].Dir != dir {
		t.Fatalf("Create calls = %+v", e.rt.Created)
	}
	if !strings.Contains(e.rt.Created[0].Command, "'fake-agent'") {
		t.Errorf("command = %q", e.rt.Created[0].Command)
	}
	if types := eventTypes(t, e.st, sess.ID); !reflect.DeepEqual(types, []string{"session.spawned", "session.state_changed"}) {
		t.Errorf("events = %v", types)
	}
	if len(sessiontest.FakeAgent.SetupCalls) != 1 || sessiontest.FakeAgent.SetupCalls[0].WorktreePath != dir {
		t.Errorf("SetupWorkspace calls = %+v", sessiontest.FakeAgent.SetupCalls)
	}
}

func TestSpawnDefaultIDFromDir(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "My Project!")
	first, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile()})
	if err != nil {
		t.Fatal(err)
	}
	second, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != "my-project" || second.ID != "my-project-2" {
		t.Errorf("ids = %q, %q; want my-project, my-project-2", first.ID, second.ID)
	}
}

func TestDefaultIDBase(t *testing.T) {
	for in, want := range map[string]string{
		"/x/My Project!":                       "my-project",
		"/x/---":                               "session",
		"/x/Проект":                            "session",
		"/x/" + strings.Repeat("a", 50):        strings.Repeat("a", 40),
		"/x/" + strings.Repeat("a", 39) + "-b": strings.Repeat("a", 39),
	} {
		if got := baseIDFromDir(in); got != want {
			t.Errorf("baseIDFromDir(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSpawnIDTakenByForeignTmux(t *testing.T) {
	e := testManager(t)
	e.rt.ListNames = []string{"my-project"}
	dir := mkdir(t, "my-project")
	sess, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID != "my-project-2" {
		t.Errorf("id = %q, want my-project-2", sess.ID)
	}
	_, err = e.m.Spawn(context.Background(), SpawnReq{ID: "my-project", Dir: dir, Profile: fakeProfile()})
	if validationCode(err) != "session_exists" {
		t.Errorf("explicit taken id: err = %v, want session_exists", err)
	}
	if len(e.rt.Destroyed) != 0 {
		t.Errorf("Destroy calls = %v, want none", e.rt.Destroyed)
	}
}

func TestSpawnRejectsBadID(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	for _, id := range []string{"Bad", "a b", "a_b", strings.Repeat("a", 61)} {
		_, err := e.m.Spawn(context.Background(), SpawnReq{ID: id, Dir: dir, Profile: fakeProfile()})
		if validationCode(err) != "invalid_id" {
			t.Errorf("id %q: err = %v, want invalid_id", id, err)
		}
	}
	if _, err := e.m.Spawn(context.Background(), SpawnReq{ID: strings.Repeat("a", 60), Dir: dir, Profile: fakeProfile()}); err != nil {
		t.Errorf("60-character id rejected: %v", err)
	}
}

func TestSpawnRejectsBadDir(t *testing.T) {
	e := testManager(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ dir, code string }{
		{filepath.Join(t.TempDir(), "missing"), "dir_not_found"},
		{file, "dir_not_found"},
		{"relative/path", "dir_not_absolute"},
	} {
		_, err := e.m.Spawn(context.Background(), SpawnReq{Dir: tc.dir, Profile: fakeProfile()})
		if validationCode(err) != tc.code {
			t.Errorf("dir %q: err = %v, want %s", tc.dir, err, tc.code)
		}
		all, err := e.st.ListSessions(store.SessionFilter{All: true})
		if err != nil || len(all) != 0 {
			t.Errorf("dir %q left sessions %+v (err %v)", tc.dir, all, err)
		}
	}
}

func TestSpawnRejectsUnknownParentAndAgent(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	_, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, ParentID: "ghost", Profile: fakeProfile()})
	if validationCode(err) != "parent_not_found" {
		t.Errorf("unknown parent: err = %v", err)
	}
	_, err = e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: LaunchProfile{Agent: "no-such-agent"}})
	if validationCode(err) != "agent_unknown" {
		t.Errorf("unknown agent: err = %v", err)
	}
	sessiontest.FakeAgent.AvailableErr = errors.New("not installed")
	_, err = e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile()})
	if validationCode(err) != "agent_unavailable" {
		t.Errorf("unavailable agent: err = %v", err)
	}
	if all, _ := e.st.ListSessions(store.SessionFilter{All: true}); len(all) != 0 {
		t.Errorf("rejected spawns left %d sessions", len(all))
	}
}

func TestSpawnWithParent(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	parent, err := e.m.Spawn(context.Background(), SpawnReq{ID: "parent", Dir: dir, Profile: fakeProfile()})
	if err != nil {
		t.Fatal(err)
	}
	child, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, ParentID: parent.ID, Profile: fakeProfile()})
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentID != "parent" || e.rt.Created[1].Env["HOPP_PARENT_ID"] != "parent" {
		t.Errorf("child = %+v, env = %v", child, e.rt.Created[1].Env)
	}
}

func TestSpawnEnvDaemonWins(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	sess, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: fakeProfile(),
		Env: map[string]string{"HOPP_SESSION_ID": "evil", "HOPP_HOME": "/evil", "HOPP_SOCKET": "/evil.sock", "FOO": "bar"}})
	if err != nil {
		t.Fatal(err)
	}
	env := e.rt.Created[0].Env
	if env["HOPP_SESSION_ID"] != sess.ID || env["HOPP_HOME"] != e.cfg.Home || env["HOPP_SOCKET"] != e.cfg.SocketPath() || env["FOO"] != "bar" {
		t.Errorf("env = %v", env)
	}
}

func TestSpawnStoresWhatRestoreNeeds(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	req := SpawnReq{Dir: dir, Labels: map[string]string{"k": "v"}, Profile: fakeProfile(),
		SystemPrompt: "be brief", FirstMessage: "hello", PermissionMode: "plan", Env: map[string]string{"FOO": "bar"}}
	sess, err := e.m.Spawn(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.st.GetSession(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.SystemPrompt != "be brief" || got.PermissionMode != "plan" || got.Env["FOO"] != "bar" ||
		got.Labels["k"] != "v" || got.Profile != "p" || got.Model != "m1" || got.Effort != "high" ||
		got.Prompt != "hello" || got.Agent != "fake" || got.WorktreePath != dir {
		t.Errorf("stored = %+v", got)
	}
	spec := sessiontest.FakeAgent.LaunchCalls[0]
	if spec.SystemPrompt != "be brief" || spec.FirstMessage != "hello" || spec.Model != "m1" || spec.Effort != "high" || spec.PermissionMode != "plan" {
		t.Errorf("launch spec = %+v", spec)
	}
}

func TestSpawnFirstMessageByInputNeedsQueue(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	prof := LaunchProfile{Agent: "fake-input"}
	_, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: prof, FirstMessage: "hi"})
	if validationCode(err) != "first_message_needs_queue" {
		t.Fatalf("err = %v, want first_message_needs_queue", err)
	}
	if all, _ := e.st.ListSessions(store.SessionFilter{All: true}); len(all) != 0 {
		t.Fatalf("left %d sessions", len(all))
	}

	var gotID, gotBody string
	e.m.SetFirstMessageQueue(func(id, body string) error { gotID, gotBody = id, body; return nil })
	var woke string
	e.m.SetWake(func(id string) { woke = id })
	sess, err := e.m.Spawn(context.Background(), SpawnReq{Dir: dir, Profile: prof, FirstMessage: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if gotID != sess.ID || gotBody != "hi" || woke != sess.ID {
		t.Errorf("queue got (%q, %q), woke %q; session %q", gotID, gotBody, woke, sess.ID)
	}
	argv := sessiontest.FakeInputAgent.LaunchCalls[0]
	if argv.FirstMessage != "" || strings.Contains(e.rt.Created[0].Command, "'hi'") {
		t.Errorf("first message reached the launch: spec %+v, command %q", argv, e.rt.Created[0].Command)
	}
}

func TestSpawnFailureMarksErrored(t *testing.T) {
	e := testManager(t)
	dir := mkdir(t, "work")
	e.rt.CreateErr = errors.New("tmux broke")
	_, err := e.m.Spawn(context.Background(), SpawnReq{ID: "s1", Dir: dir, Profile: fakeProfile()})
	if err == nil {
		t.Fatal("Spawn succeeded")
	}
	got, err := e.st.GetSession("s1")
	if err != nil || got.State != "errored" {
		t.Fatalf("stored = %+v, %v", got, err)
	}
	data, ok, err := e.st.LastSessionEventData("s1", "session.state_changed")
	if err != nil || !ok || data["to"] != "errored" || data["reason"] != "tmux broke" {
		t.Errorf("state_changed = %v, %v, %v", data, ok, err)
	}
}
