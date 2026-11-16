package store

import (
	"errors"
	"reflect"
	"testing"
)

func lessonIDs(l []Lesson) []int64 {
	out := []int64{}
	for _, x := range l {
		out = append(out, x.ID)
	}
	return out
}

func TestLessonAddGet(t *testing.T) {
	s := openTestStore(t)
	id, err := s.AddLesson(Lesson{FromSession: "s1", Labels: map[string]string{"k": "v"}, Body: "line one\nline two", CreatedAt: 10})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetLesson(id)
	if err != nil {
		t.Fatal(err)
	}
	want := Lesson{ID: id, FromSession: "s1", Labels: map[string]string{"k": "v"}, Body: "line one\nline two", Status: LessonNew, CreatedAt: 10}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if _, err := s.GetLesson(id + 100); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v, want ErrNotFound", err)
	}
}

func TestLessonListFiltersAndClose(t *testing.T) {
	s := openTestStore(t)
	a, _ := s.AddLesson(Lesson{FromSession: "s1", Labels: map[string]string{"team": "x"}, Body: "a"})
	b, _ := s.AddLesson(Lesson{FromSession: "s2", Labels: map[string]string{"team": "y"}, Body: "b"})
	c, _ := s.AddLesson(Lesson{Body: "c"})
	list := func(f LessonFilter) []int64 {
		t.Helper()
		l, err := s.ListLessons(f)
		if err != nil {
			t.Fatal(err)
		}
		return lessonIDs(l)
	}
	if got := list(LessonFilter{}); !reflect.DeepEqual(got, []int64{a, b, c}) {
		t.Errorf("default = %v", got)
	}
	if got := list(LessonFilter{Labels: map[string]string{"team": "y"}}); !reflect.DeepEqual(got, []int64{b}) {
		t.Errorf("label = %v", got)
	}
	if got := list(LessonFilter{From: "s1"}); !reflect.DeepEqual(got, []int64{a}) {
		t.Errorf("from = %v", got)
	}
	if err := s.CloseLesson(b); err != nil {
		t.Fatal(err)
	}
	closed, _ := s.GetLesson(b)
	if closed.Status != LessonClosed || closed.ClosedAt == 0 {
		t.Errorf("closed lesson = %+v", closed)
	}
	if err := s.CloseLesson(b); err != nil {
		t.Errorf("closing a closed lesson: %v, want no-op", err)
	}
	if again, _ := s.GetLesson(b); again.ClosedAt != closed.ClosedAt {
		t.Errorf("second close changed closed_at")
	}
	if got := list(LessonFilter{}); !reflect.DeepEqual(got, []int64{a, c}) {
		t.Errorf("new after close = %v", got)
	}
	if got := list(LessonFilter{Status: LessonClosed}); !reflect.DeepEqual(got, []int64{b}) {
		t.Errorf("closed = %v", got)
	}
	if got := list(LessonFilter{Status: "all"}); !reflect.DeepEqual(got, []int64{a, b, c}) {
		t.Errorf("all = %v", got)
	}
	if err := s.CloseLesson(9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("close unknown: %v, want ErrNotFound", err)
	}
}

func TestLessonSurvivesSessionRemoval(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "gone")
	id, err := s.AddLesson(Lesson{FromSession: "gone", Labels: map[string]string{"k": "v"}, Body: "keep me"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetLesson(id)
	if err != nil {
		t.Fatalf("lesson gone after RemoveSessions: %v", err)
	}
	if got.FromSession != "gone" || got.Labels["k"] != "v" {
		t.Errorf("lesson = %+v", got)
	}
}
