import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { DaemonBridge } from '../../shared/bridge';
import { hopp } from '../bridge';
import { useAgentMail, useProfiles, useShellState, useWaiting } from '../data/hooks';
import { waitingCount, waitingRows } from '../model/shellModel';
import { useSessions } from '../sessions/useSessions';
import { applyTheme, initialTheme, saveTheme, type Theme } from '../ui/theme';
import { Workspace } from '../Workspace';
import { AgentView, NewAgent } from './Agents';
import { NewTask } from './NewTask';
import { ProjectForm } from './ProjectForm';
import type { Route } from './route';
import { Settings } from './Settings';
import { Brand, Side } from './Side';
import { TaskView } from './TaskView';

function DaemonNotice(props: { daemon: DaemonBridge }) {
  const [socket, setSocket] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    props.daemon.socketPath().then(setSocket, () => {});
  }, [props.daemon]);
  return (
    <div className="side-notice" data-testid="daemon-down" role="status">
      <div className="strong">The hopp daemon is not running.</div>
      <div>Trying {socket || 'its socket'}; the app retries on its own.</div>
      <button
        type="button"
        className="c-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            const r = await props.daemon.startDaemon();
            setNote(r.ok ? 'Started. Connecting…' : r.message);
          } catch (e) {
            setNote(String((e as Error)?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Start daemon
      </button>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

// ShellApp is the whole window: projects, tasks and long-lived agents on top
// of the daemon's sessions.
export function ShellApp(props: { bridge?: HoppBridge }) {
  const bridge = props.bridge ?? hopp();
  const load = useShellState(bridge.shell);
  const ready = load.status === 'ready';
  const { stream, sessions, error: sessionsError, refresh } = useSessions(bridge.daemon);
  const { waiting } = useWaiting(bridge.shell, bridge.daemon, stream, ready);
  const mail = useAgentMail(bridge.shell, bridge.daemon, stream, ready);
  const { profiles, error: profilesError } = useProfiles(bridge.shell);
  const [route, setRoute] = useState<Route>({ k: 'newTask' });
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => applyTheme(theme), [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return next;
    });
  }, []);

  const state = ready ? load.state : null;
  const rows = useMemo(() => (state && waiting ? waitingRows(waiting, state, sessions) : []), [state, waiting, sessions]);
  const counts = useMemo(() => (state ? waitingCount(waiting, state, sessions) : new Map<string, number>()), [state, waiting, sessions]);

  if (load.status === 'unwired') {
    // The main process does not implement the shell layer yet: keep the
    // skeleton's session list so the app stays usable.
    return (
      <div className="legacy">
        <Workspace bridge={bridge} />
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app">
        <aside className="side" data-testid="zone-left">
          <Brand />
        </aside>
        <main className="work">
          {load.status === 'error' ? (
            <div className="empty-center" role="alert">
              <div>
                The app could not read its store: {load.message}{' '}
                <button type="button" className="c-btn" onClick={load.retry}>
                  Try again
                </button>
              </div>
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  // No project, no work: only "Create your first project".
  if (state.projects.length === 0) {
    return (
      <div className="app">
        <aside className="side" data-testid="zone-left">
          <Brand />
        </aside>
        <main className="work">
          <ProjectForm shell={bridge.shell} first onDone={(p) => setRoute({ k: 'newTask', project: p.slug })} />
        </main>
      </div>
    );
  }

  const daemonNotice = stream === 'down' ? <DaemonNotice daemon={bridge.daemon} /> : null;
  let view: React.ReactNode;
  switch (route.k) {
    case 'task': {
      const task = state.tasks.find((t) => t.id === route.id);
      view = task ? (
        <TaskView
          key={task.id}
          bridge={bridge}
          stream={stream}
          task={task}
          project={state.projects.find((p) => p.slug === task.projectSlug)}
          sessions={sessions}
          waiting={counts.get('task:' + task.id) ?? 0}
          panel={route.panel ?? null}
          session={route.session}
          go={setRoute}
          refreshSession={refresh}
        />
      ) : (
        <div className="empty-center">This task is no longer in the list.</div>
      );
      break;
    }
    case 'agent': {
      const agent = state.agents.find((a) => a.name === route.name);
      view = agent ? (
        <AgentView
          key={agent.name}
          bridge={bridge}
          stream={stream}
          agent={agent}
          sessions={sessions}
          mail={mail[agent.name] ?? 0}
          panel={route.panel ?? null}
          go={setRoute}
          refreshSession={refresh}
        />
      ) : (
        <div className="empty-center">This agent was removed.</div>
      );
      break;
    }
    case 'newAgent':
      view = <NewAgent shell={bridge.shell} profiles={profiles} onCreated={(a) => setRoute({ k: 'agent', name: a.name })} onCancel={() => setRoute({ k: 'newTask' })} />;
      break;
    case 'newProject':
      view = <ProjectForm shell={bridge.shell} onDone={(p) => setRoute({ k: 'newTask', project: p.slug })} onCancel={() => setRoute({ k: 'settings', tab: 'projects' })} />;
      break;
    case 'project': {
      const p = state.projects.find((x) => x.slug === route.slug);
      view = p ? (
        <ProjectForm
          key={p.slug}
          shell={bridge.shell}
          edit={p}
          onDone={() => setRoute({ k: 'settings', tab: 'projects' })}
          onCancel={() => setRoute({ k: 'settings', tab: 'projects' })}
          onRemoved={() => setRoute({ k: 'settings', tab: 'projects' })}
        />
      ) : (
        <div className="empty-center">This project was removed.</div>
      );
      break;
    }
    case 'settings':
      view = <Settings shell={bridge.shell} state={state} profiles={profiles} profilesError={profilesError} tab={route.tab} go={setRoute} />;
      break;
    default:
      view = (
        <NewTask
          key={route.project ?? ''}
          shell={bridge.shell}
          projects={state.projects}
          profiles={profiles}
          profilesError={profilesError}
          initialProject={route.project}
          onCreated={(t) => setRoute({ k: 'task', id: t.id })}
        />
      );
  }

  return (
    <div className="app">
      <Side
        state={state}
        sessions={sessions}
        waitingRows={rows}
        waitingByOwner={counts}
        mail={mail}
        route={route}
        go={setRoute}
        onTheme={toggleTheme}
        stream={stream}
        sessionsError={sessionsError}
        daemonNotice={daemonNotice}
      />
      <main className="work">{view}</main>
    </div>
  );
}
