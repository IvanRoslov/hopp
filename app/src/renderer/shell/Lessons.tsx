// The Lessons tab: lessons about hopp, about each project, and unsorted, open
// by default. A project's open lessons go into the start text of its next
// tasks until they are closed or moved to its Guardrails.
import { useState } from 'react';
import type { Lesson, LessonAbout, Project, Result, ShellBridge, ShellState } from '../../shared/shell';
import { cleanError } from '../errors';
import { groupLessons, lessonAbout, LESSON_PROJECT, type ProjectLessons } from '../model/lessons';
import { Dropdown } from '../ui/Dropdown';
import { Markdown } from '../ui/Markdown';
import { Switch } from '../ui/Switch';
import { timeAgo } from './repos';
import type { Go } from './route';

export function LessonsTab(props: { shell: ShellBridge; state: ShellState; lessons: Lesson[] | null; error: string | null; reload: () => void; go: Go }) {
  const [closed, setClosed] = useState(false);
  const shown = (props.lessons ?? []).filter((l) => (closed ? l.status === 'closed' : l.status === 'new'));
  const g = groupLessons(shown, props.state.projects);
  const word = closed ? 'closed' : 'open';
  const projectCount = g.projects.reduce((n, p) => n + p.lessons.length, 0);
  const row = (l: Lesson) => <LessonRow key={l.id} lesson={l} {...props} />;

  return (
    <div data-testid="settings-lessons">
      <div className="lessons-tools">
        <label className="lessons-closed">
          <Switch on={closed} onChange={setClosed} label="Show closed lessons" />
          <span>Closed</span>
        </label>
      </div>
      {props.error && (
        <p className="subtle-note" role="alert">
          ! {props.error}
        </p>
      )}
      {!props.lessons && !props.error && <p className="loading-note">Loading…</p>}
      {props.lessons && (
        <>
          <section className="lesson-group" aria-label="About hopp" data-testid="lessons-hopp">
            <h2>
              About hopp <span className="count">{g.hopp.length}</span>
            </h2>
            {g.hopp.length ? g.hopp.map(row) : <p className="subtle-note">No {word} lessons about hopp.</p>}
          </section>

          <section className="lesson-group" aria-label="About projects" data-testid="lessons-projects">
            <h2>
              About projects <span className="count">{projectCount}</span>
            </h2>
            <p className="subtle-note">Open lessons of a project are given to its next tasks until you close them or move them to Guardrails.</p>
            {g.projects.length === 0 && <p className="subtle-note empty">No {word} lessons about projects.</p>}
            {g.projects.map((p) => (
              <div key={p.slug || '-'} className="lesson-project" data-testid={`lessons-project-${p.slug || 'none'}`}>
                <div className="lesson-project-head">
                  <h3>{p.name}</h3>
                  <span className="count">{p.lessons.length}</span>
                  <span className="sp" />
                  {p.known && !closed && <TriageButton shell={props.shell} project={p} go={props.go} />}
                </div>
                {p.lessons.map(row)}
              </div>
            ))}
          </section>

          <section className="lesson-group" aria-label="Unsorted" data-testid="lessons-unsorted">
            <h2>
              Unsorted <span className="count">{g.unsorted.length}</span>
            </h2>
            {g.unsorted.length ? g.unsorted.map(row) : <p className="subtle-note">No {word} unsorted lessons.</p>}
          </section>
        </>
      )}
    </div>
  );
}

// TriageButton opens New task for the project with a brief that works
// through its open lessons; everything stays editable before launch.
function TriageButton(props: { shell: ShellBridge; project: ProjectLessons; go: Go }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <span className="form-error">! {error}</span>}
      <button
        type="button"
        className="link-btn"
        disabled={busy}
        data-testid={`triage-${props.project.slug}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const brief = await props.shell.triageLessonsBrief(props.project.slug);
            props.go({ k: 'newTask', project: props.project.slug, brief });
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Triage with a task…
      </button>
    </>
  );
}

function LessonRow(props: { lesson: Lesson; shell: ShellBridge; state: ShellState; reload: () => void; go: Go }) {
  const l = props.lesson;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const about = lessonAbout(l);
  const slug = l.labels?.[LESSON_PROJECT] ?? '';
  const project = props.state.projects.find((p) => p.slug === slug);
  const taskId = l.labels?.['hopp.task'];
  const task = taskId ? props.state.tasks.find((t) => t.id === taskId) : undefined;
  const role = l.labels?.['hopp.role'];

  const act = async (...steps: (() => Promise<Result<null>>)[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const s of steps) {
        const r = await s();
        if (!r.ok) {
          setError(r.error.message);
          break;
        }
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
      props.reload();
    }
  };

  const here = about === 'hopp' ? 'hopp' : about === 'project' ? 'project:' + slug : 'unsorted';
  const moves = [
    { value: 'hopp', label: 'About hopp' },
    ...props.state.projects.map((p) => ({ value: 'project:' + p.slug, label: 'About ' + p.name })),
    { value: 'unsorted', label: 'Unsorted' },
  ].filter((o) => o.value !== here);
  const move = (to: string) => {
    if (to === 'hopp') return act(() => props.shell.setLessonAbout(l.id, 'hopp' as LessonAbout));
    if (to === 'unsorted') return act(() => props.shell.setLessonAbout(l.id, null));
    const s = to.slice('project:'.length);
    return act(
      () => props.shell.setLessonProject(l.id, s),
      () => props.shell.setLessonAbout(l.id, 'project'),
    );
  };

  return (
    <article className={'lesson' + (l.status === 'closed' ? ' closed' : '')} data-testid={`lesson-${l.id}`}>
      <Markdown variant="compact" className="body selectable" text={l.body} />
      <div className="meta">
        <span className="lesson-id">#{l.id}</span>
        {role && <span>{role}</span>}
        {l.from && <span className="mono">{l.from}</span>}
        {task ? (
          <button type="button" className="link-btn" onClick={() => props.go({ k: 'task', id: task.id })}>
            {task.title}
          </button>
        ) : (
          taskId && <span>{taskId}</span>
        )}
        <span title={new Date(l.created_at * 1000).toLocaleString()}>{timeAgo(l.created_at * 1000)}</span>
        {l.status === 'closed' && <span>closed</span>}
      </div>
      {confirm && project ? (
        <div className="inline-confirm" role="alertdialog" aria-label="Add to Guardrails">
          <span>
            It will be in every start text of {project.name}, and the lesson closes.
          </span>
          <button
            type="button"
            className="c-btn primary"
            disabled={busy}
            onClick={() => {
              setConfirm(false);
              void act(() => props.shell.lessonToGuardrails(l.id));
            }}
          >
            Add to Guardrails
          </button>
          <button type="button" className="c-btn" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="btns">
          {l.status === 'new' && (
            <button type="button" className="c-btn" disabled={busy} onClick={() => void act(() => props.shell.closeLesson(l.id))}>
              Close
            </button>
          )}
          <Dropdown label="Move to…" testId={`move-${l.id}`} options={moves} value="" onChange={(v) => void move(v)} />
          {about === 'project' && project && l.status === 'new' && (
            <button type="button" className="c-btn" disabled={busy} onClick={() => setConfirm(true)}>
              Add to Guardrails
            </button>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              setCopied(await copyText(l.body));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy text'}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          ! {error}
        </p>
      )}
    </article>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// projectLessonsLink: "N open lessons" for a project page; null when none.
export function ProjectLessonsNote(props: { project: Project; count: number; go: Go }) {
  if (props.count === 0) return <p className="subtle-note">No open lessons about this project.</p>;
  return (
    <p className="subtle-note" data-testid="project-lessons">
      {props.count === 1 ? '1 open lesson' : `${props.count} open lessons`} about this project go into its next tasks.{' '}
      <button type="button" className="link-btn under" onClick={() => props.go({ k: 'settings', tab: 'lessons' })}>
        See them
      </button>
    </p>
  );
}
