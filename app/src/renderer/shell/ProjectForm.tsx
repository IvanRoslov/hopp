import { useRef, useState } from 'react';
import type { Project, ProjectInput, ShellBridge, ShellError } from '../../shared/shell';
import { slugify } from '../../shared/slug';
import { cleanError } from '../errors';
import { Field } from '../ui/Field';

const ADVANCED_FIELDS = new Set(['orchestratorRepo', 'workerRepos', 'guardrails']);

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// ProjectForm creates a project (also on first run) or edits one.
export function ProjectForm(props: {
  shell: ShellBridge;
  first?: boolean;
  edit?: Project;
  onDone: (p: Project) => void;
  onCancel?: () => void;
  onRemoved?: () => void;
}) {
  const e = props.edit;
  const [name, setName] = useState(e?.name ?? '');
  const [slug, setSlug] = useState(e?.slug ?? '');
  // The slug follows the name until the human edits it (always edited when
  // the project exists).
  const [slugTouched, setSlugTouched] = useState(!!e);
  const [description, setDescription] = useState(e?.description ?? '');
  const [orchestratorRepo, setOrchestratorRepo] = useState(e?.orchestratorRepo ?? '');
  const [workerRepos, setWorkerRepos] = useState((e?.workerRepos ?? []).join('\n'));
  const [guardrails, setGuardrails] = useState(e?.guardrails ?? '');
  const [advanced, setAdvanced] = useState(!!e && (!!e.orchestratorRepo || e.workerRepos.length > 0 || !!e.guardrails));
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // A second Enter while the first request runs does nothing.
  const inFlight = useRef(false);

  const shownSlug = slugTouched ? slug : slugify(name);
  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);

  const pick = async (apply: (dir: string) => void) => {
    try {
      const dir = await props.shell.pickFolder();
      if (dir) apply(dir);
    } catch (err) {
      setError({ code: 'pick_failed', message: cleanError(err) });
    }
  };

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const input: ProjectInput = {
      name: name.trim(),
      description: description.trim(),
      orchestratorRepo: orchestratorRepo.trim() || null,
      workerRepos: lines(workerRepos),
      guardrails: guardrails.trim(),
    };
    if (slugTouched) input.slug = slug.trim();
    try {
      const r = e ? await props.shell.updateProject(e.slug, input) : await props.shell.createProject(input);
      if (r.ok) props.onDone(r.value);
      else {
        setError(r.error);
        if (r.error.field && ADVANCED_FIELDS.has(r.error.field)) setAdvanced(true);
      }
    } catch (err) {
      setError({ code: 'failed', message: cleanError(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!e) return;
    setBusy(true);
    try {
      const r = await props.shell.removeProject(e.slug);
      if (r.ok) props.onRemoved?.();
      else setError(r.error);
    } catch (err) {
      setError({ code: 'failed', message: cleanError(err) });
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const title = props.first ? 'Create your first project' : e ? 'Project' : 'New project';
  const generalError = error && (!error.field || !['name', 'slug', 'description', ...ADVANCED_FIELDS].includes(error.field)) ? error.message : null;

  return (
    <>
      {!props.first && (
        <div className="top">
          <span className="name">{e ? e.name : 'New project'}</span>
          <span className="sp" />
          {props.onCancel && (
            <button type="button" className="c-btn" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
      <div className="page">
        <form
          className="form-col"
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
          <h1>{title}</h1>
          <div className="fields">
            <Field
              label="Name"
              value={name}
              placeholder="For example, My project"
              autoFocus
              error={fieldError('name')}
              onChange={(ev) => setName(ev.target.value)}
            />
            <Field
              label="Slug"
              value={shownSlug}
              placeholder={slugify(name) || 'my-project'}
              error={fieldError('slug')}
              hint={!e ? 'Used in folder and branch names.' : undefined}
              onChange={(ev) => {
                setSlugTouched(true);
                setSlug(ev.target.value);
              }}
            />
            <Field
              label="Description"
              multiline
              rows={2}
              value={description}
              placeholder="What this project is, in a sentence or two"
              error={fieldError('description')}
              onChange={(ev) => setDescription(ev.target.value)}
            />
          </div>
          <div className="adv-toggle">
            <button type="button" className={'c-btn' + (advanced ? ' on' : '')} aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
              {advanced ? 'Hide advanced' : 'Advanced'}
            </button>
          </div>
          {advanced && (
            <div className="advanced fields">
              <Field
                label="Worktree for the orchestrator"
                value={orchestratorRepo}
                placeholder="~/projects/site"
                hint="Each task gets a new worktree of this repository at its current commit; uncommitted changes are not included. Empty: tasks run in a plain folder."
                error={fieldError('orchestratorRepo')}
                onChange={(ev) => setOrchestratorRepo(ev.target.value)}
                after={
                  <button type="button" className="c-btn" onClick={() => void pick(setOrchestratorRepo)}>
                    Choose…
                  </button>
                }
              />
              <Field
                label="Worktrees for workers"
                multiline
                rows={3}
                value={workerRepos}
                placeholder={'~/projects/site-ui\n~/projects/site-api'}
                hint="One repository per line. If empty, workers run in the orchestrator's repository."
                error={fieldError('workerRepos')}
                onChange={(ev) => setWorkerRepos(ev.target.value)}
                after={
                  <button
                    type="button"
                    className="c-btn"
                    onClick={() => void pick((d) => setWorkerRepos((w) => (w.trim() ? w.replace(/\n*$/, '\n') + d : d)))}
                  >
                    Add folder…
                  </button>
                }
              />
              <Field
                label="Guardrails"
                multiline
                rows={3}
                value={guardrails}
                placeholder="For example: no paid actions without my go."
                hint="Every orchestrator of this project gets this text at start."
                error={fieldError('guardrails')}
                onChange={(ev) => setGuardrails(ev.target.value)}
              />
            </div>
          )}
          <div className="form-actions">
            <span className="form-error" role={generalError ? 'alert' : undefined}>
              {generalError}
            </span>
            {e && !confirmRemove && (
              <button type="button" className="link-btn" onClick={() => setConfirmRemove(true)} disabled={busy}>
                Remove project
              </button>
            )}
            {e && confirmRemove && (
              <>
                <span className="subtle-note">Remove {e.name}?</span>
                <button type="button" className="c-btn" onClick={() => void remove()} disabled={busy}>
                  Remove
                </button>
                <button type="button" className="c-btn" onClick={() => setConfirmRemove(false)}>
                  Keep
                </button>
              </>
            )}
            <button type="submit" className="c-btn primary" disabled={busy || !name.trim()}>
              {e ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
