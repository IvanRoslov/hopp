import { useMemo, useRef, useState } from 'react';
import { useModelCatalog } from '../data/hooks';
import { profileEffortTag } from '../ui/effort';
import type { HoppBridge } from '../../shared/bridge';
import type { LongAgent, ModelProfile, Result, ShellBridge, ShellError } from '../../shared/shell';
import type { Session, StreamState } from '../../shared/types';
import { cleanError } from '../errors';
import { agentStatus, sessionTree } from '../model/shellModel';
import { Dropdown } from '../ui/Dropdown';
import { Field } from '../ui/Field';
import type { Go, Panel } from './route';
import { ActionsMenu, ConfirmButton, WorkView, type MenuItem } from './WorkView';

// NewAgent: a long-lived agent stands above projects. Its role lives in its
// folder; it gets no project settings and no worktree.
export function NewAgent(props: {
  shell: ShellBridge;
  profiles: ModelProfile[] | null;
  onCreated: (a: LongAgent) => void;
  onCancel: () => void;
}) {
  const enabled = useMemo(() => (props.profiles ?? []).filter((p) => p.enabled), [props.profiles]);
  const effortsFor = useModelCatalog(props.shell);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // A picked profile that is switched off meanwhile falls back, visibly.
  const pickedOff = !!profile && !!props.profiles && !enabled.some((p) => p.name === profile);
  const chosen = (!pickedOff && profile) || enabled[0]?.name || '';
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
                options={enabled.map((p) => ({ value: p.name, label: p.name, tag: profileEffortTag(p, effortsFor(p.agent, p.model)) ?? undefined, hint: p.description || p.agent }))}
                value={chosen}
                onChange={setProfile}
              />
              {fieldError('profile') ? (
                <small className="error" role="alert">{fieldError('profile')}</small>
              ) : pickedOff ? (
                <small className="profile-note" role="status">
                  {profile} is switched off in Settings → Models; {chosen || 'no profile'} is used instead.
                </small>
              ) : null}
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
  const [error, setError] = useState<ShellError | null>(null);
  // Remove agent from the tmux-name error asks first, on its line.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const selectedId = tree.some((s) => s.id === selected) ? selected : agent.name;
  const sel = tree.find((s) => s.id === selectedId);

  const act = async (fn: () => Promise<Result<null>>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) after?.();
      else setError(r.error);
    } catch (e) {
      setError({ code: 'failed', message: cleanError(e) });
    } finally {
      setBusy(false);
    }
  };

  const off = st.kind === 'off';
  const letters = props.mail === 1 ? '1 letter waits for it' : `${props.mail} letters wait for it`;
  const removeText =
    `Remove ${agent.name}? Its folder stays as it is.` +
    (props.mail > 0 ? ` ${props.mail === 1 ? '1 letter waits' : `${props.mail} letters wait`} in its mailbox, so the mailbox stays.` : '');
  const remove = () => void act(() => shell.removeAgent(agent.name), () => go({ k: 'newTask' }));
  const startRename = () => {
    setError(null);
    setRenaming(true);
    go({ k: 'agent', name: agent.name, panel: 'details' });
  };
  const items: MenuItem[] = [];
  if (off) {
    items.push({ label: 'Rename…', run: startRename });
    items.push({ label: 'Remove agent', confirm: { text: removeText, action: 'Remove' }, run: remove });
  }
  items.push({ label: 'Agent details', run: () => go({ k: 'agent', name: agent.name, panel: 'details' }) });

  // Start or Stop, before Questions.
  const action = off ? (
    <button type="button" className="c-btn" disabled={busy} data-testid="agent-start" onClick={() => void act(() => shell.startAgent(agent.name))}>
      Start
    </button>
  ) : (
    <ConfirmButton
      label="Stop"
      testId="agent-stop"
      disabled={busy}
      confirm={{ text: `Stop ${agent.name}? Mail waits for it until it is started again.`, action: 'Stop' }}
      run={() => void act(() => shell.stopAgent(agent.name))}
    />
  );
  const status = off
    ? 'Off' + (props.mail > 0 ? ` · ${letters}` : '')
    : st.kind === 'starting'
      ? 'Starting…'
      : sel && sel.activity === 'exited'
        ? 'The agent exited. The terminal shows the shell it left.'
        : null;

  // A name a tmux session outside hopp holds: the two ways out sit beside it;
  // Remove agent asks first, on the same line.
  const alert = confirmRemove ? (
    <span className="inline-confirm" role="alertdialog" aria-label={removeText}>
      <span>{removeText}</span>
      <button
        type="button"
        className="c-btn primary"
        disabled={busy}
        onClick={() => {
          setConfirmRemove(false);
          remove();
        }}
      >
        Remove
      </button>
      <button type="button" className="c-btn" onClick={() => setConfirmRemove(false)}>
        Cancel
      </button>
    </span>
  ) : error ? (
    <span className="agent-error" role="alert">
      <span className="form-error">! {error.message}</span>
      {error.code === 'name_in_tmux' && off && (
        <>
          <button type="button" className="c-btn" onClick={startRename}>
            Rename
          </button>
          <button type="button" className="c-btn" onClick={() => setConfirmRemove(true)}>
            Remove agent
          </button>
        </>
      )}
    </span>
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
      action={action}
      status={status}
      alert={alert}
      attachable={!off && !!sel && sel.state === 'running'}
      noTerminal={off ? 'The terminal appears once the agent is started.' : 'The terminal opens when the session is running.'}
      details={
        <dl className="details" data-testid="agent-details">
          <dt>Name</dt>
          <dd>
            {renaming && off ? (
              <RenameAgent
                shell={shell}
                agent={agent}
                mail={props.mail}
                onDone={(to) => {
                  setRenaming(false);
                  setError(null);
                  go({ k: 'agent', name: to, panel: 'details' });
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span className="name-row">
                {agent.name}
                {off && (
                  <button type="button" className="link-btn" onClick={startRename}>
                    Rename
                  </button>
                )}
              </span>
            )}
          </dd>
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

// RenameAgent: a new name for an agent that is off, checked like a new
// agent's. Unread mail cannot move with it (the daemon has no such call), so
// when letters wait the rename says so and asks first.
function RenameAgent(props: { shell: ShellBridge; agent: LongAgent; mail: number; onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(props.agent.name);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const to = name.trim();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await props.shell.renameAgent(props.agent.name, to);
      if (r.ok) props.onDone(r.value.name);
      else {
        setConfirming(false);
        setError(r.error.message);
      }
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  const stay = props.mail === 1 ? '1 letter stays' : `${props.mail} letters stay`;
  return (
    <form
      className="rename-agent"
      data-testid="rename-agent"
      onSubmit={(e) => {
        e.preventDefault();
        if (!to || to === props.agent.name) return props.onCancel();
        if (props.mail > 0 && !confirming) setConfirming(true);
        else void save();
      }}
    >
      <Field
        label="New name"
        value={name}
        autoFocus
        hint="Also its session id and its mailbox name."
        error={error ?? undefined}
        onChange={(e) => {
          setName(e.target.value);
          setConfirming(false);
        }}
      />
      {confirming && (
        <p className="rename-note" role="status">
          {stay} under the old name {props.agent.name}: hopp cannot move mail, and nothing is deleted. {to} starts with an empty mailbox.
        </p>
      )}
      <div className="btns">
        <button type="submit" className="c-btn primary" disabled={busy || !to}>
          {confirming ? 'Rename anyway' : 'Rename'}
        </button>
        <button type="button" className="c-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
