// ModelProfileForm: add a profile (any harness, a catalog model or a model id
// the catalog does not list) or copy one with another effort. The name is
// filled in as the main process would name it until the human edits it.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { copyProfileName, newProfileName } from '../../shared/profileNames';
import { HARNESSES, HARNESS_EFFORTS, type CatalogModel, type ModelProfile, type ShellBridge, type ShellError } from '../../shared/shell';
import { cleanError } from '../errors';
import { Dropdown } from '../ui/Dropdown';
import { Field } from '../ui/Field';

export type ProfileFormMode = { mode: 'add' } | { mode: 'copy'; from: ModelProfile };

export function ModelProfileForm(props: {
  shell: ShellBridge;
  how: ProfileFormMode;
  profiles: ModelProfile[];
  // The catalog's models of a harness (empty while unknown).
  modelsOf: (agent: string) => CatalogModel[];
  onDone: (p: ModelProfile) => void;
  onCancel: () => void;
}) {
  const from = props.how.mode === 'copy' ? props.how.from : null;
  const [agent, setAgent] = useState(from?.agent ?? 'claude-code');
  const [model, setModel] = useState(from?.model ?? '');
  const [effort, setEffort] = useState(from?.effort ?? '');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState(from?.description ?? '');
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const effortBox = useRef<HTMLDivElement>(null);

  const suggestions = props.modelsOf(agent);
  const listed = suggestions.find((m) => m.id === model.trim());
  // A listed model offers its own levels (none: no effort knob); any other
  // id offers the harness's.
  const levels = listed ? listed.efforts : (HARNESS_EFFORTS[agent] ?? []);
  const effortShown = levels.includes(effort) || effort === '' ? effort : '';
  const taken = useMemo(() => new Set(props.profiles.map((p) => p.name)), [props.profiles]);
  const autoName = from ? copyProfileName(from, effortShown, taken) : model.trim() ? newProfileName(agent, model, effortShown, taken) : '';
  const shownName = nameTouched ? name : autoName;

  // Copy is "same model, other effort": the cursor starts on Effort.
  useEffect(() => {
    if (from) effortBox.current?.querySelector('button')?.focus();
  }, [from]);

  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = from
        ? await props.shell.copyProfile(from.name, { name: nameTouched ? name.trim() : undefined, effort: effortShown, description })
        : await props.shell.addProfile({ name: nameTouched ? name.trim() : undefined, agent, model: model.trim(), effort: effortShown, description });
      if (r.ok) props.onDone(r.value);
      else setError(r.error);
    } catch (e) {
      setError({ code: 'failed', message: cleanError(e) });
    } finally {
      setBusy(false);
    }
  };
  const general = error && !['name', 'agent', 'model', 'effort'].includes(error.field ?? '') ? error.message : null;

  return (
    <form
      className="profile-form"
      data-testid="profile-form"
      aria-label={from ? `Copy ${from.name}` : 'Add model'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="pf-head">
        <span className="pf-title">{from ? `Copy ${from.name}` : 'Add model'}</span>
        <span className="subtle-note">A profile is a harness + model + effort that a task or agent is launched with.</span>
      </div>
      <div className="pf-grid">
        <div className="field">
          <span className="fl">Harness</span>
          {from ? (
            <span className="pf-fixed">{agent}</span>
          ) : (
            <Dropdown
              label={agent}
              testId="pf-harness"
              options={HARNESSES.map((h) => ({ value: h, label: h }))}
              value={agent}
              onChange={(v) => {
                setAgent(v);
                setEffort('');
              }}
            />
          )}
          {fieldError('agent') && <small className="error" role="alert">{fieldError('agent')}</small>}
        </div>
        {from ? (
          <div className="field">
            <span className="fl">Model</span>
            <span className="pf-fixed mono">{model}</span>
          </div>
        ) : (
          <Field
            label="Model"
            value={model}
            list={listId}
            placeholder={suggestions[0]?.id ?? 'The model id the harness takes'}
            hint={listed ? listed.name || 'From the harness catalog' : model.trim() ? 'Not in the catalog: used as written' : 'Pick one from the list or type any id'}
            error={fieldError('model')}
            autoFocus
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        <datalist id={listId}>
          {suggestions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
        <div className="field" ref={effortBox}>
          <span className="fl">Effort</span>
          {levels.length > 0 ? (
            <Dropdown
              label={effortShown || 'default'}
              testId="pf-effort"
              options={[{ value: '', label: 'default' }, ...levels.map((x) => ({ value: x, label: x }))]}
              value={effortShown}
              onChange={setEffort}
            />
          ) : (
            <span className="pf-fixed muted">This model has no effort setting.</span>
          )}
          {fieldError('effort') && <small className="error" role="alert">{fieldError('effort')}</small>}
        </div>
        <Field
          label="Name"
          value={shownName}
          spellCheck={false}
          hint="a-z, 0-9 and dashes; also how tasks and agents name it."
          error={fieldError('name')}
          onChange={(e) => {
            setNameTouched(true);
            setName(e.target.value);
          }}
        />
      </div>
      <Field label="Description" multiline rows={2} value={description} placeholder="What it is good for" onChange={(e) => setDescription(e.target.value)} />
      <div className="form-actions">
        <span className="form-error" role={general ? 'alert' : undefined}>
          {general}
        </span>
        <button type="button" className="c-btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="c-btn primary" disabled={busy || (!from && !model.trim())}>
          {from ? 'Copy' : 'Add'}
        </button>
      </div>
    </form>
  );
}
