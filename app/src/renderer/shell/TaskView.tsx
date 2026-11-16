import { useState } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { Project, Result, Task } from '../../shared/shell';
import type { Session, StreamState } from '../../shared/types';
import { cleanError } from '../errors';
import { STARTING_GRACE_MS, taskSessions, toMs } from '../model/shellModel';
import type { Go, Panel, PipelinePanel } from './route';
import { ActionsMenu, TerminalArea, WorkView, type MenuItem } from './WorkView';
import { PipelineTaskView } from '../feed/PipelineTaskView';

function when(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms > 1e12 ? ms : ms * 1000);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function TaskDetails(props: { task: Task; project?: Project }) {
  const { task } = props;
  return (
    <dl className="details" data-testid="task-details">
      <dt>Project</dt>
      <dd>{props.project?.name ?? task.projectSlug}</dd>
      <dt>Task</dt>
      <dd className="brief">{task.brief}</dd>
      <dt>Session</dt>
      <dd className="mono">{task.sessionId}</dd>
      <dt>Folder</dt>
      <dd className="mono">{task.dir}</dd>
      {task.branch && (
        <>
          <dt>Branch</dt>
          <dd className="mono">{task.branch}</dd>
        </>
      )}
      <dt>Orchestrator</dt>
      <dd>{task.orchestratorProfile}</dd>
      <dt>Workers</dt>
      <dd>{task.workerProfiles.length ? task.workerProfiles.join(', ') : 'none'}</dd>
      <dt>Started</dt>
      <dd>{when(task.createdAt)}</dd>
      {task.status === 'finished' && (
        <>
          <dt>Finished</dt>
          <dd>{when(task.finishedAt)}</dd>
        </>
      )}
    </dl>
  );
}

export function TaskView(props: {
  bridge: HoppBridge;
  stream: StreamState;
  task: Task;
  project?: Project;
  sessions: Session[];
  waiting: number;
  panel: Panel;
  session?: string;
  // For a task with a pipeline: the right-hand panel, and the ask a
  // "Waiting for you" row points to.
  pipelinePanel?: PipelinePanel | null;
  focusAskId?: number;
  go: Go;
  refreshSession: (id: string) => void;
}) {
  const { task, bridge, go } = props;
  const shell = bridge.shell;
  const tree = taskSessions(task, props.sessions);
  const selectedId = props.session && tree.some((s) => s.id === props.session) ? props.session : task.sessionId;
  const selected = tree.find((s) => s.id === selectedId) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const children = Math.max(0, tree.length - 1);
  const root = tree[0];
  const rootLive = !!root && (root.state === 'running' || root.state === 'spawning');
  const young = Date.now() - toMs(task.createdAt) < STARTING_GRACE_MS;

  const act = async (fn: () => Promise<Result<null>>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) after?.();
      else setError(r.error.message);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  const resume = () => void act(() => shell.resumeTask(task.id));

  const items: MenuItem[] = [];
  if (task.status === 'active' && rootLive) {
    items.push({
      label: 'Stop task',
      confirm: {
        text: `Stop ${task.title} and its child sessions (${children})?`,
        action: 'Stop',
      },
      run: () => void act(() => shell.stopTask(task.id)),
    });
  }
  if (task.status === 'active' && !rootLive) items.push({ label: 'Resume', run: resume });
  if (task.status === 'active') {
    items.push({
      label: 'Finish task',
      confirm: {
        text: `Finish ${task.title}? Its sessions stop and it moves to Recent; the worktree is kept.`,
        action: 'Finish',
      },
      run: () => void act(() => shell.finishTask(task.id)),
    });
  }
  items.push({
    label: 'Remove from list',
    confirm: {
      text: task.status === 'active' && rootLive ? `Remove ${task.title} from the list? Its sessions keep running.` : `Remove ${task.title} from the list?`,
      action: 'Remove',
    },
    run: () => void act(() => shell.hideTask(task.id), () => go({ k: 'newTask' })),
  });
  const here = { k: 'task' as const, id: task.id, session: selectedId };
  items.push({
    label: 'Task details',
    run: () => go(task.pipeline ? { ...here, pipelinePanel: 'details' } : { ...here, panel: 'details' }),
  });

  // The line above the terminal: what state the task is in and what to do.
  let status: React.ReactNode = null;
  let noTerminal: React.ReactNode = null;
  const isRoot = selectedId === task.sessionId;
  if (task.status === 'finished') {
    status = `Finished. The worktree is kept in ${task.dir}.`;
    noTerminal = 'This task is finished.';
  } else if (!root) {
    status = young ? 'Starting…' : (
      <>
        The daemon has no session {task.sessionId}.
        <button type="button" className="c-btn" disabled={busy} onClick={resume}>Resume</button>
      </>
    );
    noTerminal = young ? 'The terminal opens when the orchestrator is running.' : 'No terminal: the session is gone.';
  } else if (selected && selected.state === 'spawning') {
    status = 'Starting…';
    noTerminal = 'The terminal opens when the session is running.';
  } else if (selected && (selected.state === 'killed' || selected.state === 'done' || selected.state === 'errored')) {
    const word = selected.state === 'errored' ? 'failed' : selected.state === 'done' ? 'ended' : 'is stopped';
    status = isRoot ? (
      <>
        {selected.state === 'errored' ? 'The orchestrator failed.' : `${task.title} ${word === 'is stopped' ? 'is stopped' : 'ended'}.`}
        <button type="button" className="c-btn" disabled={busy} onClick={resume}>Resume</button>
      </>
    ) : (
      `This session ${word}.`
    );
    noTerminal = 'No terminal: the session is not running.';
  } else if (selected && selected.activity === 'exited') {
    status = 'The agent exited. The terminal shows the shell it left.';
  }

  const statusLine =
    status || error ? (
      <>
        {status}
        {error && <span className="form-error" role="alert">! {error}</span>}
      </>
    ) : null;

  // A task with a pipeline: the feed in the center; stages, artifacts, the
  // terminal and the details open on the right (feed/PipelineTaskView).
  if (task.pipeline) {
    const pipelinePanel = props.pipelinePanel ?? null;
    return (
      <PipelineTaskView
        bridge={bridge}
        task={task}
        menu={<ActionsMenu items={items} />}
        terminal={
          <TerminalArea
            bridge={bridge}
            tree={tree}
            selectedId={selectedId}
            onSelect={(id) => go({ ...here, session: id, pipelinePanel })}
            status={null}
            attachable={!!selected && selected.state === 'running'}
            noTerminal={noTerminal}
          />
        }
        details={<TaskDetails task={task} project={props.project} />}
        status={statusLine}
        panel={pipelinePanel}
        onPanel={(p) => go({ ...here, pipelinePanel: p })}
        focusAskId={props.focusAskId}
      />
    );
  }

  return (
    <WorkView
      bridge={bridge}
      stream={props.stream}
      title={task.title}
      tree={tree}
      selectedId={selectedId}
      onSelect={(id) => go({ k: 'task', id: task.id, panel: props.panel, session: id })}
      panel={props.panel}
      onPanel={(p) => go({ k: 'task', id: task.id, panel: p, session: selectedId })}
      menu={<ActionsMenu items={items} />}
      status={statusLine}
      attachable={!!selected && selected.state === 'running'}
      noTerminal={noTerminal}
      details={<TaskDetails task={task} project={props.project} />}
      refreshSession={props.refreshSession}
    />
  );
}
