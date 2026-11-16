import { useEffect, useRef, useState } from 'react';
import type { Pipeline, PipelineInput, PipelineStageInput, ShellBridge, ShellError } from '../../shared/shell';
import { cleanError } from '../errors';
import { Checkbox } from '../ui/Checkbox';
import { Field } from '../ui/Field';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from '../ui/icons';
import type { Go } from './route';

// A draft keeps a key per stage so React keeps each card while stages move.
interface DraftStage extends PipelineStageInput {
  key: string;
}
interface Draft {
  name: string;
  stages: DraftStage[];
}

let keySeq = 0;
const newKey = () => 'k' + ++keySeq;
const blankStage = (): DraftStage => ({ key: newKey(), name: '', does: '', result: '', substages: false, approval: true });

function toDraft(p: Pipeline | null): Draft {
  if (!p) return { name: '', stages: [blankStage()] };
  return { name: p.name, stages: p.stages.map((s) => ({ ...s, key: newKey() })) };
}

function toInput(d: Draft): PipelineInput {
  return {
    name: d.name.trim(),
    stages: d.stages.map(({ key: _key, ...s }) => ({ ...s, name: s.name.trim(), does: s.does.trim(), result: s.result.trim() })),
  };
}

const same = (a: Draft, b: Draft) => JSON.stringify(toInput(a)) === JSON.stringify(toInput(b));

// Pipelines: the list on the left, the editor of the chosen one in the
// center. Unsaved drafts are kept per pipeline while the human moves between
// them.
export function Pipelines(props: { shell: ShellBridge; pipelines: Pipeline[]; selected?: string; go: Go }) {
  const { pipelines, go } = props;
  const selectedId = props.selected === 'new' ? 'new' : pipelines.find((p) => p.id === props.selected)?.id ?? pipelines[0]?.id ?? 'new';
  const current = pipelines.find((p) => p.id === selectedId) ?? null;
  const drafts = useRef(new Map<string, Draft>());
  const [, bump] = useState(0);
  const draft = drafts.current.get(selectedId) ?? toDraft(current);
  const saved = toDraft(current);
  const dirty = (id: string) => {
    const d = drafts.current.get(id);
    return !!d && !same(d, toDraft(pipelines.find((p) => p.id === id) ?? null));
  };
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setError(null);
    setConfirmDelete(false);
  }, [selectedId]);

  const update = (fn: (d: Draft) => Draft) => {
    drafts.current.set(selectedId, fn(draft));
    bump((n) => n + 1);
  };
  const setStage = (i: number, patch: Partial<DraftStage>) =>
    update((d) => ({ ...d, stages: d.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, by: number) =>
    update((d) => {
      const stages = d.stages.slice();
      const [s] = stages.splice(i, 1);
      stages.splice(i + by, 0, s!);
      return { ...d, stages };
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input = toInput(draft);
      const r = current ? await props.shell.updatePipeline(current.id, input) : await props.shell.createPipeline(input);
      if (r.ok) {
        drafts.current.delete(selectedId);
        go({ k: 'pipelines', id: r.value.id });
      } else setError(r.error);
    } catch (e) {
      setError({ code: 'failed', message: cleanError(e) });
    } finally {
      setBusy(false);
      bump((n) => n + 1);
    }
  };

  const remove = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const r = await props.shell.removePipeline(current.id);
      if (r.ok) {
        drafts.current.delete(current.id);
        go({ k: 'pipelines' });
      } else setError(r.error);
    } catch (e) {
      setError({ code: 'failed', message: cleanError(e) });
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);
  const general = error && !(error.field === 'name' || /^stages\.\d+\./.test(error.field ?? '')) ? error.message : null;
  const isDirty = !same(draft, saved);

  return (
    <>
      <div className="top">
        <span className="name">Pipelines</span>
      </div>
      <div className="page">
        <div className="pl-layout">
          <nav className="pl-list" aria-label="Pipelines">
            {pipelines.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'row' + (p.id === selectedId ? ' sel' : '')}
                title={p.name}
                data-testid="pipeline-row"
                onClick={() => go({ k: 'pipelines', id: p.id })}
              >
                <span className="t">{p.name}</span>
                {dirty(p.id) && <span className="dirty" title="Unsaved changes">•</span>}
              </button>
            ))}
            {selectedId === 'new' && (
              <div className="row sel">
                <span className="t">{draft.name.trim() || 'New pipeline'}</span>
              </div>
            )}
            <button type="button" className="c-btn" onClick={() => go({ k: 'pipelines', id: 'new' })} disabled={selectedId === 'new'}>
              <PlusIcon width={14} height={14} />
              New pipeline
            </button>
          </nav>
          <form
            className="pl-edit"
            aria-label="Pipeline"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field
              label="Pipeline name"
              value={draft.name}
              placeholder="For example, Landing page"
              error={fieldError('name')}
              onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
            />
            {draft.stages.map((s, i) => (
              <section key={s.key} className="pl-stage" aria-label={`Stage ${i + 1}`} data-testid="pipeline-stage">
                <div className="head-row">
                  <Field
                    label="Stage name"
                    value={s.name}
                    placeholder={`Stage ${i + 1}`}
                    error={fieldError(`stages.${i}.name`)}
                    onChange={(e) => setStage(i, { name: e.target.value })}
                  />
                  <div className="tools">
                    <button type="button" className="c-btn icon" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUpIcon />
                    </button>
                    <button
                      type="button"
                      className="c-btn icon"
                      aria-label="Move down"
                      title="Move down"
                      disabled={i === draft.stages.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDownIcon />
                    </button>
                    <button
                      type="button"
                      className="c-btn"
                      disabled={draft.stages.length === 1}
                      onClick={() => update((d) => ({ ...d, stages: d.stages.filter((_, j) => j !== i) }))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <Field
                  label="What the stage does"
                  multiline
                  rows={2}
                  value={s.does}
                  error={fieldError(`stages.${i}.does`)}
                  onChange={(e) => setStage(i, { does: e.target.value })}
                />
                <Field
                  label="What the result looks like"
                  multiline
                  rows={2}
                  value={s.result}
                  hint={i === 0 ? 'A hint for the orchestrator, not a fixed requirement for every task.' : undefined}
                  error={fieldError(`stages.${i}.result`)}
                  onChange={(e) => setStage(i, { result: e.target.value })}
                />
                <div className="cb-row">
                  <Checkbox label="may have substages" checked={s.substages} onChange={(v) => setStage(i, { substages: v })} />
                  <Checkbox label="wait for approval" checked={s.approval} onChange={(v) => setStage(i, { approval: v })} />
                </div>
              </section>
            ))}
            <div className="btns add-stage">
              <button type="button" className="c-btn" onClick={() => update((d) => ({ ...d, stages: [...d.stages, blankStage()] }))}>
                <PlusIcon width={14} height={14} />
                Add stage
              </button>
            </div>
            <div className="form-actions">
              <span className="form-error" role={general ? 'alert' : undefined}>
                {general}
              </span>
              {current && !confirmDelete && (
                <button type="button" className="link-btn" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete pipeline
                </button>
              )}
              {current && confirmDelete && (
                <>
                  <span className="subtle-note">Delete {current.name}? Running tasks keep their copy.</span>
                  <button type="button" className="c-btn" onClick={() => void remove()} disabled={busy}>
                    Delete pipeline
                  </button>
                  <button type="button" className="c-btn" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </>
              )}
              {isDirty && current && (
                <button
                  type="button"
                  className="c-btn"
                  onClick={() => {
                    drafts.current.delete(selectedId);
                    setError(null);
                    bump((n) => n + 1);
                  }}
                >
                  Discard
                </button>
              )}
              <button type="submit" className="c-btn primary" disabled={busy || (!!current && !isDirty)}>
                {current ? 'Save' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
