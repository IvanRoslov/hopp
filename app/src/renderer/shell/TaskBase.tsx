// What a task's worktree started from, and the warning when the clone could
// not be fetched first (the start may then be behind GitHub). Tasks stored
// before this was recorded have no base and show nothing.
import { useState } from 'react';
import type { Project, Task, TaskBase } from '../../shared/shell';
import { timeAgo, useRepoName } from './repos';

// "origin/main · 9d10cd1 · 5 minutes ago"
export function baseLine(b: TaskBase, now = Date.now()): string {
  return [b.ref, b.commit.slice(0, 7), timeAgo(b.committedAt * 1000, now)].filter(Boolean).join(' · ');
}

function stateOf(b: TaskBase): string {
  return new Date(b.committedAt * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// The sentence of the warning: which repository, and the state the task got.
export function useBaseWarning(task: Task, project?: Project): string | null {
  const name = useRepoName()(project?.orchestratorRepo ?? '');
  const b = task.base;
  if (!b?.warning) return null;
  const repo = name ?? project?.orchestratorRepo ?? 'the repository';
  return `Could not fetch ${repo}; started from the state of ${stateOf(b)}.`;
}

const DISMISSED_KEY = 'hopp.baseWarning.dismissed';
function dismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// useBaseDismissal: whether the human dismissed the fetch warning of this
// task (remembered per task), and how to dismiss it.
export function useBaseDismissal(taskId: string): { gone: boolean; dismiss: () => void } {
  const [gone, setGone] = useState<{ id: string; gone: boolean }>(() => ({ id: taskId, gone: dismissed().includes(taskId) }));
  const current = gone.id === taskId ? gone.gone : dismissed().includes(taskId);
  return {
    gone: current,
    dismiss: () => {
      setGone({ id: taskId, gone: true });
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed(), taskId].slice(-200)));
      } catch {
        // Not remembered; it shows again next time.
      }
    },
  };
}

// BaseWarning: on the task screen, until the human dismisses it for this task.
export function BaseWarning(props: { task: Task; project?: Project; onDismiss: () => void }) {
  const text = useBaseWarning(props.task, props.project);
  if (!text) return null;
  return (
    <div className="base-warning" role="status" data-testid="base-warning">
      <span className="bw-mark" aria-hidden>
        !
      </span>
      <span className="bw-text">
        <span>{text}</span>
        <span className="bw-reason">{props.task.base!.warning}</span>
      </span>
      <button type="button" className="link-btn" onClick={props.onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

// The "Started from" rows of the task details.
export function BaseRows(props: { task: Task; project?: Project }) {
  const b = props.task.base;
  const warning = useBaseWarning(props.task, props.project);
  if (!b) return null;
  return (
    <>
      <dt>Started from</dt>
      <dd className="mono" title={b.commit} data-testid="task-base">
        {baseLine(b)}
        {warning && (
          <span className="base-detail-warning">
            {warning} {b.warning}
          </span>
        )}
      </dd>
    </>
  );
}
