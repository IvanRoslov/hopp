import type { LongAgent, ShellState, Task } from '../../shared/shell';
import type { Session, StreamState } from '../../shared/types';
import { agentStatus, recentTasks, taskStatus, workGroups, type Status, type WaitingRow } from '../model/shellModel';
import { LogoMark, PlusIcon, RightIcon, SlidersIcon, ThemeIcon } from '../ui/icons';
import type { Go, Route } from './route';

export function Mark(props: { status: Status }) {
  const k = props.status.kind;
  if (k === 'working') return <span className="mark" title="working"><span className="ring dot" /></span>;
  if (k === 'idle') return <span className="mark" title="idle"><span className="ring" /></span>;
  return null;
}

// Line2 is the second line of a row: states that are words, not marks.
export function Line2(props: { status: Status }) {
  const k = props.status.kind;
  if (k === 'waiting') return <span className="line2 wait"><span className="glyph">•</span>{props.status.word}</span>;
  if (k === 'error' || k === 'gone') return <span className="line2 error"><span className="glyph">!</span>{props.status.word}</span>;
  if (k === 'stopped' || k === 'exited' || k === 'starting') return <span className="line2">{props.status.word}</span>;
  return null;
}

function TaskRow(props: { task: Task; status: Status; sel: boolean; go: Go }) {
  const { task, status } = props;
  const two = status.kind !== 'working' && status.kind !== 'idle';
  return (
    <button
      type="button"
      className={'row' + (two ? ' two' : '') + (props.sel ? ' sel' : '')}
      title={task.title}
      data-testid="task-row"
      data-id={task.id}
      onClick={() => props.go({ k: 'task', id: task.id })}
    >
      <span className="t">{task.title}</span>
      {two ? <Line2 status={status} /> : <Mark status={status} />}
    </button>
  );
}

function AgentRow(props: { agent: LongAgent; status: Status; mail: number; sel: boolean; go: Go }) {
  const { agent, status } = props;
  return (
    <button
      type="button"
      className={'row' + (props.sel ? ' sel' : '')}
      title={agent.name}
      data-testid="agent-row"
      data-id={agent.name}
      onClick={() => props.go({ k: 'agent', name: agent.name })}
    >
      <span className="t">{agent.name}</span>
      {status.kind === 'off' ? (
        <span className="mark off" title="off">{props.mail > 0 ? `off · ${props.mail}` : 'off'}</span>
      ) : status.kind === 'waiting' ? (
        <span className="mark off" title="waiting for me">•</span>
      ) : (
        <Mark status={status} />
      )}
    </button>
  );
}

export function Brand(props: { children?: React.ReactNode }) {
  return (
    <div className="brand">
      <LogoMark />
      <b>hopp</b>
      {props.children}
    </div>
  );
}

export function Side(props: {
  state: ShellState;
  sessions: Session[];
  waitingRows: WaitingRow[];
  waitingByOwner: Map<string, number>;
  mail: Record<string, number>;
  route: Route;
  go: Go;
  onTheme: () => void;
  stream: StreamState;
  sessionsError: string | null;
  daemonNotice: React.ReactNode;
}) {
  const { state, sessions, route, go } = props;
  const groups = workGroups(state);
  const recent = recentTasks(state);
  const selTask = route.k === 'task' ? route.id : null;
  const selAgent = route.k === 'agent' ? route.name : null;
  const status = (t: Task) => taskStatus(t, sessions, props.waitingByOwner.get('task:' + t.id) ?? 0);

  return (
    <aside className="side" data-testid="zone-left">
      <Brand />
      <div className="side-top">
        <button type="button" className={'row' + (route.k === 'newTask' ? ' sel' : '')} onClick={() => go({ k: 'newTask' })}>
          <span className="ic"><PlusIcon /></span>
          <span className="t">New task</span>
        </button>
        <button type="button" className={'row' + (route.k === 'pipelines' ? ' sel' : '')} onClick={() => go({ k: 'pipelines' })}>
          <span className="ic"><RightIcon /></span>
          <span className="t">Pipelines</span>
        </button>
      </div>
      <div className="side-scroll">
        {props.daemonNotice}
        {props.sessionsError && props.stream === 'open' && (
          <div className="side-notice" role="alert">Could not load sessions: {props.sessionsError}</div>
        )}
        {props.waitingRows.length > 0 && (
          <section aria-label="Waiting for you">
            <div className="head">Waiting for you</div>
            {props.waitingRows.map((r) => (
              <button
                key={r.key}
                type="button"
                className="row ask"
                data-testid="waiting-row"
                title={r.text}
                onClick={() => {
                  if (r.owner?.kind === 'task') go({ k: 'task', id: r.owner.id, panel: 'questions', session: r.session, focusAskId: r.askId });
                  else if (r.owner?.kind === 'agent') go({ k: 'agent', name: r.owner.name, panel: 'questions' });
                }}
                disabled={!r.owner}
              >
                <span className="t">{r.text}</span>
                <small>{r.under}</small>
              </button>
            ))}
          </section>
        )}
        {groups.length > 0 && (
          <section aria-label="Work">
            <div className="head">Work</div>
            {groups.map((g) => (
              <div key={g.project.slug}>
                <div className="project-head" title={g.project.name}>{g.project.name}</div>
                {g.tasks.map((t) => (
                  <TaskRow key={t.id} task={t} status={status(t)} sel={selTask === t.id} go={go} />
                ))}
              </div>
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section aria-label="Recent">
            <div className="head">Recent</div>
            {recent.map((t) => (
              <button
                key={t.id}
                type="button"
                className={'row quiet' + (selTask === t.id ? ' sel' : '')}
                title={t.title}
                data-testid="recent-row"
                onClick={() => go({ k: 'task', id: t.id })}
              >
                <span className="t">{t.title}</span>
              </button>
            ))}
          </section>
        )}
      </div>
      <div className="side-foot">
        {state.agents.length > 0 && (
          <>
            <div className="head">Agents</div>
            <div className="agent-dock">
              {state.agents.map((a) => (
                <AgentRow key={a.name} agent={a} status={agentStatus(a, sessions)} mail={props.mail[a.name] ?? 0} sel={selAgent === a.name} go={go} />
              ))}
            </div>
          </>
        )}
        <button type="button" className={'row' + (route.k === 'newAgent' ? ' sel' : '')} onClick={() => go({ k: 'newAgent' })}>
          <span className="ic"><PlusIcon /></span>
          <span className="t">New agent</span>
        </button>
        <div className="side-bottom">
          <button type="button" className={'row quiet' + (route.k === 'settings' ? ' sel' : '')} onClick={() => go({ k: 'settings', tab: 'projects' })}>
            <span className="ic"><SlidersIcon /></span>
            <span className="t">Settings</span>
          </button>
          <button type="button" className="c-btn icon" aria-label="Switch theme" title="Switch theme" onClick={props.onTheme}>
            <ThemeIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
