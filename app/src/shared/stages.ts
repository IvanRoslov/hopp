// deriveStages computes each stage's state from a task's posts and asks. The
// daemon knows nothing about stages: everything comes from labels (see LABEL
// in shell.ts). Shared by the main process and the page.
//
// not started → started (a stage_started post, or anything else posted with
// the stage's label) → submitted (an open submission ask) → accepted (answered
// Accept) or returned (answered Return; a later start or submission moves it
// on; any answer that is not an acceptance counts as a return, see
// shared/submission.ts). A withdrawn or dismissed submission returns the
// stage to started. A stage that does
// not wait for approval is accepted when the next stage starts or a
// stage_done post says so.
import type { Ask } from './types';
import { submissionOutcome } from './submission';
import {
  EVENT_STAGE_DONE,
  KIND_SUBMISSION,
  LABEL,
  type Pipeline,
  type Post,
  type StageState,
} from './shell';

const labelsOf = (x: { labels: Record<string, string> | null }): Record<string, string> => x.labels ?? {};

export function isSubmission(a: Ask): boolean {
  return labelsOf(a)[LABEL.kind] === KIND_SUBMISSION;
}

export function deriveStages(pipeline: Pipeline, posts: Post[], asks: Ask[]): StageState[] {
  const states: StageState[] = pipeline.stages.map((s) => ({
    stageId: s.id, status: 'not_started', substages: [], submission: null, lastAnswer: null,
  }));
  const byId = new Map(states.map((s) => [s.stageId, s]));
  const doneMarks = new Set<string>();
  const events: { ts: number; order: number; run: () => void }[] = [];

  const noteSubstage = (st: StageState, l: Record<string, string>) => {
    const slug = l[LABEL.substage];
    if (!slug) return;
    const title = l[LABEL.substageTitle];
    const known = st.substages.find((x) => x.slug === slug);
    // The first title seen names it, even when it came after the first post.
    if (known) {
      if (title && known.title === slug) known.title = title;
      return;
    }
    st.substages.push({ slug, title: title || slug });
  };
  const start = (st: StageState) => {
    if (st.status === 'not_started' || st.status === 'returned') st.status = 'started';
  };

  for (const p of posts) {
    const l = labelsOf(p);
    const st = byId.get(l[LABEL.stage] ?? '');
    if (!st) continue;
    events.push({
      ts: p.created_at, order: p.id * 2,
      run: () => {
        noteSubstage(st, l);
        if (l[LABEL.event] === EVENT_STAGE_DONE) doneMarks.add(st.stageId);
        else start(st);
      },
    });
  }

  for (const a of asks) {
    const l = labelsOf(a);
    const st = byId.get(l[LABEL.stage] ?? '');
    if (!st) continue;
    const sub = isSubmission(a);
    events.push({
      ts: a.created_at, order: a.id * 2 + 1,
      run: () => {
        noteSubstage(st, l);
        if (!sub) return start(st);
        st.status = 'submitted';
        st.submission = a;
      },
    });
    if (sub && a.status !== 'open') {
      events.push({
        // A close can never come before its ask (clocks, coarse seconds).
        ts: Math.max(a.closed_at || 0, a.created_at), order: a.id * 2 + 1,
        run: () => {
          if (st.submission?.id !== a.id) {
            // A newer submission replaced this one; only remember the answer.
            if (a.status === 'answered' && (!st.lastAnswer || st.lastAnswer.id < a.id)) st.lastAnswer = a;
            return;
          }
          st.submission = null;
          if (a.status === 'answered') {
            st.lastAnswer = a;
            // Only an acceptance accepts (shared/submission.ts); any other
            // answer returns the stage with that answer.
            st.status = submissionOutcome(a);
          } else {
            st.status = 'started'; // withdrawn
          }
        },
      });
    }
  }

  events.sort((x, y) => x.ts - y.ts || x.order - y.order);
  for (const e of events) e.run();

  pipeline.stages.forEach((stage, i) => {
    const st = states[i]!;
    if (stage.approval || st.status === 'accepted' || st.status === 'not_started' || st.status === 'submitted') return;
    const laterStarted = states.slice(i + 1).some((x) => x.status !== 'not_started');
    if (doneMarks.has(stage.id) || laterStarted) st.status = 'accepted';
  });
  return states;
}
