import { useMemo, useRef, useState } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { LongAgent, ModelProfile, Result, ShellBridge, ShellError } from '../../shared/shell';
import type { Session, StreamState } from '../../shared/types';
import { cleanError } from '../errors';
import { agentStatus, sessionTree } from '../model/shellModel';
import { Dropdown } from '../ui/Dropdown';
import { Field } from '../ui/Field';
import type { Go, Panel } from './route';
import { ActionsMenu, WorkView, type MenuItem } from './WorkView';

// NewAgent: a long-lived agent stands above projects. Its role lives in its
// folder; it gets no project settings and no worktree.
export function NewAgent(props: {
  shell: ShellBridge;
  profiles: ModelProfile[] | null;
  onCreated: (a: LongAgent) => void;
  onCancel: () => void;
}) {
  const enabled = useMemo(() => (props.profiles ?? []).filter((p) => p.enabled), [props.profiles]);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const chosen = profile || enabled[0]?.name || '';
  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await props.shell.createAgent({ name: name.trim(), profile: chosen, dir: dir.trim() });
      if (r.ok) props.onCreated(r.value);
      else setError(r.error);
    } catch (e) {
      setError({ code: 'failed', message: cleanError(e) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const general = error && !['name', 'dir', 'profile'].includes(error.field ?? '') ? error.message : null;
  return (
    <>
      <div className="top">
        <span className="name">New agent</span>
        <span className="sp" />
        <button type="button" className="c-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <div className="page">
        <form
          className="form-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h1>New agent</h1>
          <p className="subtle-note">A long-lived agent keeps its own session and mailbox. Its role lives in the files of its folder.</p>
          <div className="fields">
            <Field
              label="Name"
              value={name}
              autoFocus
              placeholder="For example, docs"
              hint="Also its session id and its mailbox name."
              error={fieldError('name')}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="field">
              <span className="fl">Model</span>
              <Dropdown
                label={chosen || (props.profiles ? 'No enabled profiles' : '…')}
                testId="pick-agent-profile"
                options={enabled.map((p) => ({ value: p.name, label: p.name, hint: p.description || p.agent }))}
                value={chosen}
                onChange={setProfile}
              />
              {fieldError('profile') && <small className="error" role="alert">{fieldError('profile')}</small>}
            </div>
            <Field
              label="Folder"
              value={dir}
              placeholder="~/agents/docs"
              error={fieldError('dir')}
              onChange={(e) => setDir(e.target.value)}
              after={
                <button
                  type="button"
                  className="c-btn"
                  onClick={async () => {
                    try {
                      const d = await props.shell.pickFolder();
                      if (d) setDir(d);
                    } catch (e) {
                      setError({ code: 'pick_failed', message: cleanError(e) });
                    }
                  }}
                >
                  Choose…
                </button>
              }
            />
          </div>
          <div className="form-actions">
            <span className="form-error" role={general ? 'alert' : undefined}>
              {general}
            </span>
            <button type="submit" className="c-btn primary" disabled={busy || !name.trim() || !dir.trim() || !chosen}>
              Create
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export function AgentView(props: {
  bridge: HoppBridge;
  stream: StreamState;
  agent: LongAgent;
  sessions: Session[];
  mail: number;
  panel: Panel;
  go: Go;
  refreshSession: (id: string) => void;
}) {
  const { agent, bridge, go } = props;
  const shell = bridge.shell;
  const st = agentStatus(agent, props.sessions);
  // The agent's own session and any it launched.
  const tree = sessionTree(agent.name, props.sessions);
  const [selected, setSelected] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = tree.some((s) => s.id === selected) ? selected : agent.name;
  const sel = tree.find((s) => s.id === selectedId);

  const act = async (fn: () => Promise<Result<null>>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) after?.();
      else setError(r.error.message);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };

  const off = st.kind === 'off';
  const items: MenuItem[] = [];
  if (!off) {
    items.push({
      label: 'Stop agent',
      confirm: { text: `Stop ${agent.name}? Mail waits for it until it is started again.`, action: 'Stop' },
      run: () => void act(() => shell.stopAgent(agent.name)),
    });
  } else {
    items.push({ label: 'Start', run: () => void act(() => shell.startAgent(agent.name)) });
    items.push({
      label: 'Remove agent',
      confirm: { text: `Remove ${agent.name}? Its folder stays as it is.`, action: 'Remove' },
      run: () => void act(() => shell.removeAgent(agent.name), () => go({ k: 'newTask' })),
    });
  }
  items.push({ label: 'Agent details', run: () => go({ k: 'agent', name: agent.name, panel: 'details' }) });

  const letters = props.mail === 1 ? '1 letter waits for it' : `${props.mail} letters wait for it`;
  const status = off ? (
    <>
      {agent.name} is off{props.mail > 0 ? ` · ${letters}` : ''}
      <button type="button" className="c-btn" disabled={busy} onClick={() => void act(() => shell.startAgent(agent.name))}>
        Start
      </button>
    </>
  ) : st.kind === 'starting' ? (
    'Starting…'
  ) : sel && sel.activity === 'exited' ? (
    'The agent exited. The terminal shows the shell it left.'
  ) : null;

  return (
    <WorkView
      bridge={bridge}
      stream={props.stream}
      title={agent.name}
      tree={off ? [] : tree}
      selectedId={selectedId}
      onSelect={setSelected}
      panel={props.panel}
      onPanel={(p) => go({ k: 'agent', name: agent.name, panel: p })}
      menu={<ActionsMenu items={items} />}
      status={
        status || error ? (
          <>
            {status}
            {error && <span className="form-error" role="alert">! {error}</span>}
          </>
        ) : null
      }
      attachable={!off && !!sel && sel.state === 'running'}
      noTerminal={off ? 'The terminal appears once the agent is started.' : 'The terminal opens when the session is running.'}
      details={
        <dl className="details" data-testid="agent-details">
          <dt>Name</dt>
          <dd>{agent.name}</dd>
          <dt>Model</dt>
          <dd>{agent.profile}</dd>
          <dt>Folder</dt>
          <dd className="mono">{agent.dir}</dd>
        </dl>
      }
      refreshSession={props.refreshSession}
    />
  );
}
