import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelProfile, Pipeline, Project, ShellBridge, ShellError, Task, TaskInput } from '../../shared/shell';
import { slugify } from '../../shared/slug';
import { cleanError } from '../errors';
import { Checkbox } from '../ui/Checkbox';
import { Dropdown } from '../ui/Dropdown';
import { Field } from '../ui/Field';
import { UpIcon } from '../ui/icons';

const MORE_FIELDS = new Set(['title', 'sessionName', 'extraSystemPrompt']);
const LAST_KEY = 'hopp.newTask.last';

interface Last {
  project?: string;
  orchestrator?: string;
  workers?: string[];
}

function readLast(): Last {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Last;
  } catch {
    return {};
  }
}

function saveLast(l: Last): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(l));
  } catch {
    // Not remembered; harmless.
  }
}

export function titleFrom(brief: string): string {
  return (brief.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 60);
}

// NewTask: what needs to be done, where, and which models do it.
export function NewTask(props: {
  shell: ShellBridge;
  projects: Project[];
  pipelines: Pipeline[];
  profiles: ModelProfile[] | null;
  profilesError: string | null;
  initialProject?: string;
  onCreated: (t: Task) => void;
}) {
  const enabled = useMemo(() => (props.profiles ?? []).filter((p) => p.enabled), [props.profiles]);
  const last = useMemo(readLast, []);
  const firstProject = props.projects.find((p) => p.slug === props.initialProject) ?? props.projects.find((p) => p.slug === last.project) ?? props.projects[0];

  const [brief, setBrief] = useState('');
  const [project, setProject] = useState(firstProject?.slug ?? '');
  const [orchestrator, setOrchestrator] = useState('');
  const [workers, setWorkers] = useState<string[] | null>(null);
  const [more, setMore] = useState(false);
  // "No pipeline" by default, every time.
  const [pipelineId, setPipelineId] = useState('');
  const [title, setTitle] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<ShellError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Defaults once the profiles arrive: the last choice if it is still
  // enabled, else the first enabled profile.
  useEffect(() => {
    if (!enabled.length) return;
    const names = new Set(enabled.map((p) => p.name));
    setOrchestrator((o) => (o && names.has(o) ? o : last.orchestrator && names.has(last.orchestrator) ? last.orchestrator : enabled[0]!.name));
    setWorkers((w) => {
      if (w) return w.filter((x) => names.has(x));
      const prev = (last.workers ?? []).filter((x) => names.has(x));
      return prev.length ? prev : [enabled[0]!.name];
    });
  }, [enabled, last]);

  const proj = props.projects.find((p) => p.slug === project);
  const pipeline = props.pipelines.find((p) => p.id === pipelineId) ?? null;
  const effectiveTitle = title.trim() || titleFrom(brief);
  const fieldError = (f: string) => (error?.field === f ? error.message : undefined);
  const ready = brief.trim() !== '' && !!proj && !!orchestrator && !busy;

  const submit = async () => {
    if (!ready || !proj || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const input: TaskInput = { projectSlug: proj.slug, brief: brief.trim(), orchestratorProfile: orchestrator, workerProfiles: workers ?? [] };
    if (title.trim()) input.title = title.trim();
    if (sessionName.trim()) input.sessionName = sessionName.trim();
    if (extra.trim()) input.extraSystemPrompt = extra.trim();
    if (pipeline) input.pipelineId = pipeline.id;
    try {
      const r = await props.shell.createTask(input);
      if (r.ok) {
        saveLast({ project: proj.slug, orchestrator, workers: workers ?? [] });
        props.onCreated(r.value);
      } else {
        setError(r.error);
        if (r.error.field && MORE_FIELDS.has(r.error.field)) setMore(true);
      }
    } catch (err) {
      setError({ code: 'failed', message: cleanError(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const profileOptions = enabled.map((p) => ({ value: p.name, label: p.name, hint: p.description || p.agent }));
  const workersLabel = workers && workers.length ? workers.join(', ') : 'none';
  const generalError = error && (!error.field || !MORE_FIELDS.has(error.field)) ? error.message : null;
  const where = proj
    ? proj.orchestratorRepo
      ? `A new worktree of ${proj.orchestratorRepo} at its current commit; uncommitted changes are not included.`
      : 'A new folder for this task'
    : '';

  return (
    <>
      <div className="top">
        <span className="name">New task</span>
      </div>
      <div className="page">
        <form
          className="brief-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="newbox">
            <textarea
              aria-label="What needs to be done?"
              placeholder="What needs to be done?"
              value={brief}
              autoFocus
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="bar">
              <Dropdown
                label={`Project: ${proj?.name ?? 'choose'}`}
                testId="pick-project"
                options={props.projects.map((p) => ({ value: p.slug, label: p.name }))}
                value={project}
                onChange={setProject}
              />
              <Dropdown
                label={`Orchestrator: ${orchestrator || (props.profiles ? 'none enabled' : '…')}`}
                testId="pick-orchestrator"
                options={profileOptions}
                empty="No enabled model profiles"
                value={orchestrator}
                onChange={setOrchestrator}
              />
              <Dropdown
                multiple
                label={`Workers: ${workersLabel}`}
                testId="pick-workers"
                title={workersLabel}
                options={profileOptions}
                empty="No enabled model profiles"
                value={workers ?? []}
                onChange={setWorkers}
              />
              <Dropdown
                label={`Pipeline: ${pipeline?.name ?? 'No pipeline'}`}
                testId="pick-pipeline"
                options={[{ value: '', label: 'No pipeline' }, ...props.pipelines.map((p) => ({ value: p.id, label: p.name }))]}
                value={pipelineId}
                onChange={setPipelineId}
              />
              <span className="sp" />
              <button type="button" className={'c-btn' + (more ? ' on' : '')} aria-expanded={more} onClick={() => setMore((m) => !m)}>
                More
              </button>
              <button type="submit" className="c-btn send" aria-label="Start the task" title="Start the task (⌘↩)" disabled={!ready}>
                <UpIcon />
              </button>
            </div>
          </div>
          <div className={'folder-hint' + (generalError ? ' error' : '')} role={generalError ? 'alert' : undefined}>
            {busy ? 'Starting the orchestrator…' : generalError ?? (props.profilesError ? `Model profiles: ${props.profilesError}` : where)}
          </div>
          {pipeline && (
            <div className="pl-preview" data-testid="pipeline-preview">
              <div className="pl-chain">{pipeline.stages.map((st) => st.name).join(' → ')}</div>
              {pipeline.stages.map((st) => (
                <div key={st.id} className="pl-preview-stage">
                  <div className="nm">{st.name}</div>
                  {st.does && <div className="ds">{st.does}</div>}
                  <div className="cb-row">
                    <Checkbox readOnly label="may have substages" checked={st.substages} />
                    <Checkbox readOnly label="wait for approval" checked={st.approval} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {more && (
            <div className="more-box fields">
              <Field
                label="Title"
                value={title}
                placeholder={titleFrom(brief) || 'The first line of the task'}
                error={fieldError('title')}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Field
                label="Session name"
                value={sessionName}
                placeholder={slugify(effectiveTitle) || 'from the title'}
                hint="The orchestrator's session id. Made unique if it is taken."
                error={fieldError('sessionName')}
                onChange={(e) => setSessionName(e.target.value)}
              />
              <Field
                label="Extra system prompt"
                multiline
                rows={4}
                value={extra}
                placeholder="Anything the orchestrator should know beyond the project's settings"
                error={fieldError('extraSystemPrompt')}
                onChange={(e) => setExtra(e.target.value)}
              />
            </div>
          )}
        </form>
      </div>
    </>
  );
}
