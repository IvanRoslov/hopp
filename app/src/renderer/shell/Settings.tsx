import { useCallback, useEffect, useState } from 'react';
import { LessonsTab } from './Lessons';
import { ModelsTab } from './Models';
import { RepoLabel } from './repos';
import type { Lesson, ModelProfile, ShellBridge, ShellState, Tool, ToolCatalog, ToolRules } from '../../shared/shell';
import { cleanError } from '../errors';
import { PlusIcon } from '../ui/icons';
import { Switch } from '../ui/Switch';
import { Tabs } from '../ui/Tabs';
import type { Go, SettingsTab } from './route';

const tabs = (openLessons: number): { id: SettingsTab; label: string }[] => [
  { id: 'projects', label: 'Projects' },
  { id: 'models', label: 'Models' },
  { id: 'tools', label: 'Tools' },
  { id: 'lessons', label: openLessons > 0 ? `Lessons · ${openLessons}` : 'Lessons' },
];

function when(sec: number): string {
  if (!sec) return '';
  return new Date(sec > 1e12 ? sec : sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function Settings(props: {
  shell: ShellBridge;
  state: ShellState;
  profiles: ModelProfile[] | null;
  profilesError: string | null;
  tab: SettingsTab;
  go: Go;
  lessons: Lesson[] | null;
  lessonsError: string | null;
  reloadLessons: () => void;
}) {
  const open = (props.lessons ?? []).filter((l) => l.status === 'new').length;
  return (
    <>
      <div className="top">
        <span className="name">Settings</span>
      </div>
      {/* The tabs stay put; only the tab's content scrolls under them. */}
      <div className="settings-head">
        <div className="settings-head-col">
          <Tabs tabs={tabs(open)} value={props.tab} onChange={(t) => props.go({ k: 'settings', tab: t })} />
        </div>
      </div>
      <div className="page settings-page">
        <div className="settings-col">
          {props.tab === 'projects' && <ProjectsTab state={props.state} go={props.go} />}
          {props.tab === 'models' && <ModelsTab shell={props.shell} profiles={props.profiles} error={props.profilesError} />}
          {props.tab === 'tools' && <ToolsTab shell={props.shell} />}
          {props.tab === 'lessons' && (
            <LessonsTab shell={props.shell} state={props.state} lessons={props.lessons} error={props.lessonsError} reload={props.reloadLessons} go={props.go} />
          )}
        </div>
      </div>
    </>
  );
}

function ProjectsTab(props: { state: ShellState; go: Go }) {
  return (
    <div data-testid="settings-projects">
      {props.state.projects.map((p) => {
        const tasks = props.state.tasks.filter((t) => t.projectSlug === p.slug && !t.hidden && t.status === 'active').length;
        return (
          <button key={p.slug} type="button" className="set-row" onClick={() => props.go({ k: 'project', slug: p.slug })}>
            <span className="txt">
              <div className="nm">{p.name}</div>
              <div className="ds">{p.orchestratorRepo ? <RepoLabel path={p.orchestratorRepo} /> : 'No repository: tasks run in a plain folder'}</div>
            </span>
            <span className="def">{tasks ? `${tasks} active ${tasks === 1 ? 'task' : 'tasks'}` : ''}</span>
          </button>
        );
      })}
      <button type="button" className="c-btn new-project" onClick={() => props.go({ k: 'newProject' })}>
        <PlusIcon width={14} height={14} />
        New project
      </button>
    </div>
  );
}

function ToolRow(props: { shell: ShellBridge; tool: Tool; onChanged: () => void }) {
  const { tool } = props;
  const [usage, setUsage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flags = [tool.paid ? 'paid — only after your go' : null, tool.via, tool.harnesses.length ? tool.harnesses.join(', ') : null]
    .filter(Boolean)
    .join(' · ');
  const toggleUsage = async () => {
    setOpen((o) => !o);
    if (usage === null) {
      try {
        setUsage(await props.shell.toolUsage(tool.name));
      } catch (e) {
        setUsage('');
        setError(cleanError(e));
      }
    }
  };
  return (
    <div data-testid={`tool-${tool.name}`}>
      <div className="set-row">
        <button type="button" className="txt" aria-expanded={open} onClick={() => void toggleUsage()}>
          <div className="nm">{tool.name}</div>
          <div className="ds">{tool.description}</div>
          {flags && <div className="tool-flags">{flags}</div>}
        </button>
        <Switch
          on={tool.enabled}
          label={`${tool.name} ${tool.enabled ? 'on' : 'off'}`}
          onChange={async (on) => {
            setError(null);
            try {
              const r = await props.shell.setToolEnabled(tool.name, on);
              if (!r.ok) setError(r.error.message);
            } catch (e) {
              setError(cleanError(e));
            }
            props.onChanged();
          }}
        />
      </div>
      {error && <p className="subtle-note" role="alert">! {error}</p>}
      {open && usage !== null && <div className="usage">{usage || 'This tool has no USAGE.md.'}</div>}
    </div>
  );
}

function ToolsTab(props: { shell: ShellBridge }) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [rules, setRules] = useState<ToolRules | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    props.shell.listTools().then(setCatalog, (e) => setError(cleanError(e)));
  }, [props.shell]);
  useEffect(() => {
    load();
    props.shell.toolRules().then(
      (r) => {
        setRules(r);
        setDraft(r.text);
      },
      (e) => setError(cleanError(e)),
    );
  }, [props.shell, load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await props.shell.setToolRules(draft);
      if (r.ok) {
        setRules(r.value);
        setDraft(r.value.text);
      } else setError(r.error.message);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="settings-tools">
      <div className="field">
        <label className="fl" htmlFor="tool-rules">
          Preferences
        </label>
        <textarea
          id="tool-rules"
          rows={4}
          value={draft}
          placeholder="Which tool or model to use for what"
          onChange={(e) => setDraft(e.target.value)}
        />
        <small>{rules ? (rules.modifiedAt ? `Saved ${when(rules.modifiedAt)}` : 'Not written yet') : ' '}</small>
      </div>
      <div className="btns rules-actions">
        <button type="button" className="c-btn" disabled={saving || !rules || draft === rules.text} onClick={() => void save()}>
          Save preferences
        </button>
      </div>
      {error && <p className="subtle-note" role="alert">! {error}</p>}
      <div className="tool-list">
        {catalog?.tools.map((t) => <ToolRow key={t.name} shell={props.shell} tool={t} onChanged={load} />)}
        {catalog?.broken.map((b) => (
          <div key={b.name} className="set-row" data-testid={`tool-broken-${b.name}`}>
            <span className="txt">
              <div className="nm">{b.name}</div>
              <div className="ds">Broken: {b.error}</div>
            </span>
            <span className="def">broken</span>
          </div>
        ))}
        {!catalog && !error && <p className="loading-note">Reading the tool catalog…</p>}
        {catalog && catalog.tools.length === 0 && catalog.broken.length === 0 && <p className="subtle-note">No tools in the catalog.</p>}
      </div>
    </div>
  );
}

