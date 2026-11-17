// Settings → Models: the daemon's model profiles, managed in place. Each
// profile can be switched on or off (new tasks and agents offer the ones on),
// made the default, described, given an effort where its harness takes one,
// moved, or removed. Import models adds a switched-off profile for every
// current model the installed harnesses offer that has none yet.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HarnessCatalog, ImportResult, ModelProfile, Result, ShellBridge } from '../../shared/shell';
import { cleanError } from '../errors';
import { Dropdown } from '../ui/Dropdown';
import { Switch } from '../ui/Switch';
import { ActionsMenu, type MenuItem } from './WorkView';

type Run = <T>(call: () => Promise<Result<T>>) => Promise<boolean>;

export function ModelsTab(props: { shell: ShellBridge; profiles: ModelProfile[] | null; error: string | null }) {
  const { shell, profiles } = props;
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Profiles the last import added: marked until the tab is left.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const catalog = useCatalog(shell);

  const runImport = async () => {
    setImporting(true);
    setImportError(null);
    setImported(null);
    try {
      const r = await shell.importModels();
      if (r.ok) {
        setImported(r.value);
        setFresh(new Set(r.value.added.map((p) => p.name)));
        catalog.reset();
      } else setImportError(r.error.message);
    } catch (err) {
      setImportError(cleanError(err));
    } finally {
      setImporting(false);
    }
  };

  const on = (profiles ?? []).filter((p) => p.enabled);
  const off = (profiles ?? []).filter((p) => !p.enabled);

  return (
    <div data-testid="settings-models">
      <div className="models-head">
        <p className="subtle-note">New tasks and agents offer the profiles that are on. The default is used when a launch names none.</p>
        <button type="button" className="c-btn" disabled={importing} onClick={() => void runImport()} data-testid="import-models">
          {importing ? (
            <>
              <span className="repo-spinner" aria-hidden /> Importing…
            </>
          ) : (
            'Import models'
          )}
        </button>
      </div>
      {(imported || importError || importing) && (
        <ImportNote importing={importing} result={imported} error={importError} onClose={() => {
          setImported(null);
          setImportError(null);
        }} />
      )}
      {props.error ? (
        <p className="subtle-note" role="alert">Could not read the model profiles: {props.error}</p>
      ) : !profiles ? (
        <p className="subtle-note">Loading…</p>
      ) : profiles.length === 0 ? (
        <p className="subtle-note">No model profiles yet. Import models to add the ones your harnesses offer.</p>
      ) : (
        <>
          <Group title="On" list={on} shell={shell} fresh={fresh} catalog={catalog} />
          <Group title="Off" list={off} shell={shell} fresh={fresh} catalog={catalog} />
        </>
      )}
    </div>
  );
}

function ImportNote(props: { importing: boolean; result: ImportResult | null; error: string | null; onClose: () => void }) {
  const r = props.result;
  let body: React.ReactNode;
  if (props.importing) body = 'Asking each installed harness which models it offers…';
  else if (props.error) body = `Could not import models: ${props.error}`;
  else if (r && r.added.length > 0) {
    body = (
      <>
        Added {r.added.length} {r.added.length === 1 ? 'model' : 'models'}, switched off: turn on the ones you want.
      </>
    );
  } else body = 'Nothing new: every current model already has a profile.';
  return (
    <div className={'models-note' + (props.error ? ' error' : '')} role="status" data-testid="import-note">
      <div className="mn-body">
        <div>{body}</div>
        {r && r.failed.length > 0 && (
          <ul className="mn-failed">
            {r.failed.map((f) => (
              <li key={f.agent}>
                <span className="tag">{f.agent}</span> {f.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!props.importing && (
        <button type="button" className="link-btn" onClick={props.onClose}>
          Dismiss
        </button>
      )}
    </div>
  );
}

function Group(props: { title: string; list: ModelProfile[]; shell: ShellBridge; fresh: Set<string>; catalog: CatalogState }) {
  if (props.list.length === 0) return null;
  return (
    <section className="models-group" aria-label={`Profiles ${props.title.toLowerCase()}`}>
      <h2 className="models-group-title">
        {props.title} <span className="count">{props.list.length}</span>
      </h2>
      {props.list.map((p, i) => (
        <ProfileRow
          key={p.name}
          shell={props.shell}
          profile={p}
          prev={props.list[i - 1] ?? null}
          next={props.list[i + 1] ?? null}
          fresh={props.fresh.has(p.name)}
          catalog={props.catalog}
        />
      ))}
    </section>
  );
}

function ProfileRow(props: {
  shell: ShellBridge;
  profile: ModelProfile;
  prev: ModelProfile | null;
  next: ModelProfile | null;
  fresh: boolean;
  catalog: CatalogState;
}) {
  const { shell, profile: p } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // A refusal is about the profile as it was; once it changes, it goes.
  useEffect(() => setError(null), [p.enabled, p.isDefault, p.description, p.effort, p.position]);

  // run: one change at a time; a refusal is shown next to the row.
  const run: Run = async (call) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (!r.ok) setError(r.error.message);
      return r.ok;
    } catch (err) {
      setError(cleanError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const items: MenuItem[] = [{ label: 'Edit…', run: () => setEditing(true) }];
  if (p.enabled && !p.isDefault) items.push({ label: 'Make default', run: () => void run(() => shell.setDefaultProfile(p.name)) });
  if (props.prev) items.push({ label: 'Move up', run: () => void run(() => shell.moveProfile(p.name, props.prev!.position)) });
  if (props.next) items.push({ label: 'Move down', run: () => void run(() => shell.moveProfile(p.name, props.next!.position)) });
  items.push({
    label: 'Remove…',
    confirm: { text: `Remove the profile ${p.name}? It can be imported or added again later.`, action: 'Remove' },
    run: () => void run(() => shell.removeProfile(p.name)),
  });

  const sub = [p.model && p.model !== p.name ? p.model : null, p.effort ? `effort ${p.effort}` : null].filter(Boolean).join(' · ');

  return (
    <div className={'model-row' + (p.enabled ? '' : ' off') + (props.fresh ? ' fresh' : '')} data-testid="model-row" data-name={p.name}>
      <div className="mr-main">
        <div className="mr-name">
          <span className="nm">{p.name}</span>
          <span className="tag" title="Harness">
            {p.agent}
          </span>
          {p.isDefault && <span className="tag strong">Default</span>}
          {props.fresh && <span className="tag new">New</span>}
        </div>
        {sub && <div className="mr-sub">{sub}</div>}
        {!editing && p.description && <div className="mr-desc">{p.description}</div>}
        {editing && (
          <ProfileEditor
            profile={p}
            catalog={props.catalog}
            busy={busy}
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
            onSave={async (update) => {
              if (await run(() => shell.updateProfile(p.name, update))) setEditing(false);
            }}
          />
        )}
        {error && (
          <small className="mr-error" role="alert">
            {error}
          </small>
        )}
      </div>
      <div className="mr-side">
        <Switch on={p.enabled} label={`Use ${p.name}`} disabled={busy} onChange={(v) => void run(() => shell.setProfileEnabled(p.name, v))} />
        <ActionsMenu items={items} testId={`model-menu-${p.name}`} />
      </div>
    </div>
  );
}

function ProfileEditor(props: {
  profile: ModelProfile;
  catalog: CatalogState;
  busy: boolean;
  onCancel: () => void;
  onSave: (update: { description: string; effort?: string }) => void;
}) {
  const p = props.profile;
  const [description, setDescription] = useState(p.description);
  const [effort, setEffort] = useState(p.effort);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    props.catalog.load();
    box.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const efforts = props.catalog.effortsFor(p.agent, p.model);
  const changed = description !== p.description || effort !== p.effort;
  return (
    <form
      className="mr-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (!changed) return props.onCancel();
        props.onSave(effort !== p.effort ? { description: description.trim(), effort } : { description: description.trim() });
      }}
    >
      <label className="fl" htmlFor={`desc-${p.name}`}>
        Description
      </label>
      <textarea
        id={`desc-${p.name}`}
        ref={box}
        className="text-input"
        value={description}
        placeholder="What this profile is good for: the orchestrator reads it when it picks a worker"
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="mr-edit-bar">
        {efforts.length > 0 && (
          <Dropdown
            label={`Effort: ${effort || 'default'}`}
            testId={`effort-${p.name}`}
            value={effort}
            options={[{ value: '', label: 'default' }, ...efforts.map((x) => ({ value: x, label: x }))]}
            onChange={setEffort}
          />
        )}
        <span className="sp" />
        <button type="button" className="c-btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="c-btn primary" disabled={props.busy || !changed}>
          {props.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// The harnesses' catalogs, read once when an editor first needs efforts.
interface CatalogState {
  load: () => void;
  reset: () => void;
  effortsFor: (agent: string, model: string) => string[];
}

function useCatalog(shell: ShellBridge): CatalogState {
  const [list, setList] = useState<HarnessCatalog[] | null>(null);
  const asked = useRef(false);
  return useMemo(
    () => ({
      load: () => {
        if (asked.current) return;
        asked.current = true;
        shell.modelCatalog().then(
          (r) => setList(r.ok ? r.value : []),
          () => setList([]),
        );
      },
      reset: () => {
        asked.current = false;
        setList(null);
      },
      effortsFor: (agent, model) => list?.find((c) => c.agent === agent)?.models.find((m) => m.id === model)?.efforts ?? [],
    }),
    [shell, list],
  );
}
