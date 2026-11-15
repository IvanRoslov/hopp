package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/IvanRoslov/hopp/internal/runtime"
)

func TestNewPermissionQuizShape(t *testing.T) {
	p := runtime.PermissionPrompt{
		Title:   "Do you want to proceed?",
		Context: "Bash command\nrm -rf build",
		Options: []string{"Yes", "No"},
		Raw:     "raw tail",
	}
	q := NewPermissionQuiz(p, 7, 1759300000)

	b, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"source":   "permission",
		"asked_at": float64(1759300000),
		"raw":      "raw tail",
		"questions": []any{map[string]any{
			"header":      "Разрешение",
			"question":    "Do you want to proceed?\n\nBash command\nrm -rf build",
			"multiSelect": false,
			"options": []any{
				map[string]any{"label": "Yes", "description": ""},
				map[string]any{"label": "No", "description": ""},
			},
		}},
		"permission": map[string]any{"prompt_id": float64(7), "title": "Do you want to proceed?", "context": "Bash command\nrm -rf build"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("JSON =\n%s\nwant\n%v", b, want)
	}
}

func TestNewPermissionQuizWithoutContextOrOptions(t *testing.T) {
	q := NewPermissionQuiz(runtime.PermissionPrompt{Title: "Do you want to proceed?", Raw: "r"}, 1, 1)
	if got := q.Questions[0].Question; got != "Do you want to proceed?" {
		t.Errorf("question = %q, want bare title", got)
	}
	b, _ := json.Marshal(q)
	var got struct {
		Questions []struct {
			Options json.RawMessage `json:"options"`
		} `json:"questions"`
	}
	_ = json.Unmarshal(b, &got)
	if string(got.Questions[0].Options) != "[]" {
		t.Errorf("options = %s, want []", got.Questions[0].Options)
	}
}

func TestParseQuizRoundTripsPermission(t *testing.T) {
	p := runtime.PermissionPrompt{Title: "T?", Context: "C", Options: []string{"Yes"}}
	b, _ := json.Marshal(NewPermissionQuiz(p, 3, 10))

	q, ok := ParseQuiz(string(b))
	if !ok || !q.IsPermission() {
		t.Fatalf("ParseQuiz = %+v, %v; want a permission quiz", q, ok)
	}
	if !q.PermissionPrompt().SameDialog(p) || q.Permission.PromptID != 3 {
		t.Errorf("parsed permission = %+v", q.Permission)
	}
}

func TestParseQuizHookQuizIsNotPermission(t *testing.T) {
	q, ok := ParseQuiz(`{"questions":[{"question":"q","header":"h","multiSelect":false,"options":[]}],"asked_at":5}`)
	if !ok || q.IsPermission() {
		t.Errorf("hook quiz parsed as %+v ok=%v", q, ok)
	}
	if _, ok := ParseQuiz(""); ok {
		t.Errorf("empty pending quiz parsed ok")
	}
	if _, ok := ParseQuiz("{"); ok {
		t.Errorf("malformed pending quiz parsed ok")
	}
}

func paneFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "runtime", "testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}

func TestNewStartScreenQuizIsFlagged(t *testing.T) {
	p, _ := runtime.ParseStartScreen(paneFixture(t, "codex-start-trust.pane"))
	q := NewStartScreenQuiz(p, 7, 1)
	if !q.IsPermission() || !q.IsStartScreen() || q.Permission.PromptID != 7 {
		t.Errorf("quiz = %+v, want a start-screen permission quiz", q)
	}
	if got := len(q.Questions[0].Options); got != 2 {
		t.Errorf("options = %d, want 2", got)
	}
	if NewPermissionQuiz(p, 7, 1).IsStartScreen() {
		t.Error("a plain permission quiz reports IsStartScreen")
	}
}

func TestNewKimiStartScreenQuizIsUnnumbered(t *testing.T) {
	p, _ := runtime.ParseKimiStartScreen(paneFixture(t, "kimi-trust.pane"))
	q := NewKimiStartScreenQuiz(p, 7, 1)
	if !q.IsStartScreen() || !q.Permission.Unnumbered || q.Questions[0].Header != "Экран Kimi Code" {
		t.Errorf("quiz = %+v", q)
	}
	if NewStartScreenQuiz(p, 7, 1).Permission.Unnumbered {
		t.Error("Codex start-screen quiz flagged unnumbered")
	}
}
