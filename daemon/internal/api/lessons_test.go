package api

import (
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

type lessonOut struct {
	ID        int64             `json:"id"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	Body      string            `json:"body"`
	Status    string            `json:"status"`
	CreatedAt int64             `json:"created_at"`
	ClosedAt  int64             `json:"closed_at"`
}

func addLesson(t *testing.T, e apiEnv, body map[string]any) lessonOut {
	t.Helper()
	var out lessonOut
	if code := e.call(t, "POST", "/v1/lessons", body, &out); code != http.StatusCreated {
		t.Fatalf("POST /v1/lessons %v: %d", body, code)
	}
	return out
}

func listLessonIDs(t *testing.T, e apiEnv, query string) []int64 {
	t.Helper()
	var out struct {
		Lessons []lessonOut `json:"lessons"`
	}
	if code := e.call(t, "GET", "/v1/lessons"+query, nil, &out); code != http.StatusOK {
		t.Fatalf("list %s: %d", query, code)
	}
	ids := []int64{}
	for _, l := range out.Lessons {
		ids = append(ids, l.ID)
	}
	return ids
}

func TestLessonCreateCopiesSessionLabels(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a", "run": "1"}})
	l := addLesson(t, e, map[string]any{"from": "s1", "body": "the hook was slow", "labels": map[string]string{"run": "2", "topic": "hooks"}})
	want := map[string]string{"team": "a", "run": "2", "topic": "hooks"}
	if l.From != "s1" || l.Body != "the hook was slow" || l.Status != "new" || l.CreatedAt == 0 || !reflect.DeepEqual(l.Labels, want) {
		t.Errorf("lesson = %+v, want labels %v", l, want)
	}
	h := addLesson(t, e, map[string]any{"body": "from the human"})
	if h.From != "" || h.Labels == nil || len(h.Labels) != 0 {
		t.Errorf("human lesson = %+v", h)
	}
}

func TestLessonCreateValidation(t *testing.T) {
	e := newAPIEnv(t)
	for _, body := range []map[string]any{{"body": "  \n "}, {"from": "ghost", "body": "x"}} {
		if code, ecode := sessErrCode(t, e, "POST", "/v1/lessons", body); code != http.StatusBadRequest || ecode != "bad_request" {
			t.Errorf("%v: %d %q, want 400 bad_request", body, code, ecode)
		}
	}
}

func TestLessonListFiltersAndClose(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	a := addLesson(t, e, map[string]any{"from": "s1", "body": "a"})
	b := addLesson(t, e, map[string]any{"body": "b", "labels": map[string]string{"team": "b"}})
	for q, want := range map[string][]int64{
		"":                 {a.ID, b.ID},
		"?label=team=a":    {a.ID},
		"?from=s1":         {a.ID},
		"?status=closed":   {},
		"?status=all":      {a.ID, b.ID},
		"?label=team=none": {},
	} {
		if got := listLessonIDs(t, e, q); !reflect.DeepEqual(got, want) {
			t.Errorf("%q -> %v, want %v", q, got, want)
		}
	}
	var closed lessonOut
	if code := e.call(t, "POST", fmt.Sprintf("/v1/lessons/%d/close", a.ID), nil, &closed); code != http.StatusOK ||
		closed.Status != "closed" || closed.ClosedAt == 0 {
		t.Fatalf("close: %d %+v", code, closed)
	}
	if got := listLessonIDs(t, e, ""); !reflect.DeepEqual(got, []int64{b.ID}) {
		t.Errorf("new after close = %v", got)
	}
	if got := listLessonIDs(t, e, "?status=closed"); !reflect.DeepEqual(got, []int64{a.ID}) {
		t.Errorf("closed = %v", got)
	}
	if code, ecode := sessErrCode(t, e, "POST", "/v1/lessons/999/close", nil); code != http.StatusNotFound || ecode != "lesson_not_found" {
		t.Errorf("close unknown: %d %q", code, ecode)
	}
	for _, q := range []string{"?label=nokv", "?status=bogus"} {
		if code := e.call(t, "GET", "/v1/lessons"+q, nil, nil); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", q, code)
		}
	}
}

func TestLessonAddedEventIsPublished(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	l := addLesson(t, e, map[string]any{"from": "s1", "body": "x"})
	evs, err := e.st.ListEvents(0, 0, "s1")
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if ev.Type == "lesson.added" {
			if ev.Data["id"] != float64(l.ID) {
				t.Errorf("lesson.added data = %v", ev.Data)
			}
			return
		}
	}
	t.Errorf("no lesson.added event among %d events", len(evs))
}
