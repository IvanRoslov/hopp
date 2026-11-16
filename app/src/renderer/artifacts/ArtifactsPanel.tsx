// ArtifactsPanel: every artifact of the task as a grid (latest version of
// each name), with search and a stage filter, and a viewer with a version
// picker and a side-by-side compare.
import { useEffect, useState } from 'react';
import type { Artifact, Pipeline, ShellBridge } from '../../shared/shell';
import { LABEL } from '../../shared/shell';
import type { Ask } from '../../shared/types';
import { cleanError } from '../errors';
import { artifactKind, latestByName, submittedRefs } from '../feed/model';
import { Dropdown } from '../ui/Dropdown';
import { ArtifactTile } from './Tile';

export function ArtifactsPanel(props: {
  shell: ShellBridge;
  pipeline: Pipeline | null;
  artifacts: Artifact[];
  asks: Ask[];
  stageFilter: string;
  onStageFilter: (s: string) => void;
  viewing: Artifact | null;
  onView: (a: Artifact | null) => void;
  onOpenSubmission: (askId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const submitted = submittedRefs(props.asks);
  const openSubmission = props.asks.find((a) => a.status === 'open' && a.labels?.[LABEL.kind] === 'submission');

  if (props.viewing) {
    return <Viewer {...props} artifact={props.viewing} submitted={submitted} />;
  }

  const q = query.trim().toLowerCase();
  const shown = latestByName(props.artifacts).filter(
    (a) => (!props.stageFilter || a.labels[LABEL.stage] === props.stageFilter) && (!q || a.name.toLowerCase().includes(q) || a.filename.toLowerCase().includes(q)),
  );
  const stageOptions = [{ value: '', label: 'All stages' }, ...(props.pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))];
  const cur = stageOptions.find((o) => o.value === props.stageFilter) ?? stageOptions[0]!;

  return (
    <div className="arts" data-testid="artifacts-panel">
      <div className="arts-tools">
        <input className="text-input" type="search" placeholder="Find an artifact" aria-label="Find an artifact" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Dropdown label={cur.label} testId="artifacts-stage" options={stageOptions} value={props.stageFilter} onChange={props.onStageFilter} />
      </div>
      <div className="arts-scroll">
        {props.artifacts.length === 0 ? (
          <div className="q-empty">No artifacts yet. The orchestrator publishes them with hopp artifact publish.</div>
        ) : shown.length === 0 ? (
          <div className="q-empty">Nothing matches.</div>
        ) : (
          <div className="arts-grid">
            {shown.map((a) => {
              const anySubmitted = [...submitted].some((r) => r.startsWith(a.name + '@'));
              return <ArtifactTile key={a.id} shell={props.shell} artifact={a} onOpen={props.onView} size="grid" showKind submitted={anySubmitted} />;
            })}
          </div>
        )}
      </div>
      {openSubmission && (
        <div className="arts-foot">
          <button type="button" className="link-btn under" onClick={() => props.onOpenSubmission(openSubmission.id)}>
            Open the submission and decide
          </button>
        </div>
      )}
    </div>
  );
}

function Viewer(props: {
  shell: ShellBridge;
  artifacts: Artifact[];
  artifact: Artifact;
  submitted: Set<string>;
  onView: (a: Artifact | null) => void;
}) {
  const a = props.artifact;
  const versions = props.artifacts.filter((x) => x.name === a.name).sort((x, y) => y.version - x.version);
  const [compare, setCompare] = useState<Artifact | null>(null);
  useEffect(() => setCompare(null), [a.name]);
  const label = (x: Artifact) => `Version ${x.version}` + (props.submitted.has(`${x.name}@${x.version}`) ? ' · submitted' : '');
  const opts = versions.map((x) => ({ value: String(x.id), label: label(x) }));
  const pick = (id: string) => props.artifacts.find((x) => String(x.id) === id) ?? null;
  const other = versions.find((x) => x.id !== a.id) ?? null;

  return (
    <div className="arts viewer" data-testid="artifact-viewer">
      <div className="viewer-bar">
        <button type="button" className="c-btn" onClick={() => props.onView(null)}>
          All artifacts
        </button>
        <span className="viewer-name ellipsis" title={a.filename}>
          {a.name}
        </span>
        <Dropdown label={label(a)} testId="version-picker" options={opts} value={String(a.id)} onChange={(id) => props.onView(pick(id) ?? a)} />
        {versions.length > 1 && (
          <button
            type="button"
            className={'c-btn' + (compare ? ' on' : '')}
            aria-pressed={!!compare}
            onClick={() => setCompare(compare ? null : other)}
          >
            Compare
          </button>
        )}
      </div>
      <div className={'viewer-body' + (compare ? ' split' : '')}>
        {compare && (
          <figure className="viewer-pane">
            <figcaption>
              <Dropdown label={label(compare)} testId="compare-picker" options={opts.filter((o) => o.value !== String(a.id))} value={String(compare.id)} onChange={(id) => setCompare(pick(id))} />
            </figcaption>
            <Show shell={props.shell} artifact={compare} />
          </figure>
        )}
        <figure className="viewer-pane">
          {compare && <figcaption>{label(a)}</figcaption>}
          <Show shell={props.shell} artifact={a} />
        </figure>
      </div>
      <div className="viewer-meta faint">
        {a.filename} · {fmtSize(a.size)} · {a.mime || 'unknown type'}
      </div>
    </div>
  );
}

function Show(props: { shell: ShellBridge; artifact: Artifact }) {
  const a = props.artifact;
  const kind = artifactKind(a);
  const url = props.shell.artifactUrl(a.id);
  if (kind === 'image') return <img className="viewer-img" src={url} alt={a.name} />;
  if (kind === 'video') return <video className="viewer-video" src={url} controls preload="metadata" />;
  if (kind === 'html') return <iframe className="viewer-frame" src={url} title={a.name} sandbox="" />;
  if (kind === 'text') return <TextView shell={props.shell} artifact={a} />;
  return <div className="q-empty">This file cannot be shown here.</div>;
}

function TextView(props: { shell: ShellBridge; artifact: Artifact }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    props.shell
      .artifactText(props.artifact.id)
      .then((r) => {
        if (!live) return;
        if (r.ok) setText(r.value);
        else setError(r.error.message);
      })
      .catch((err) => live && setError(cleanError(err)));
    return () => {
      live = false;
    };
  }, [props.shell, props.artifact.id]);
  if (error) return <div className="q-empty" role="alert">{error}</div>;
  if (text === null) return <div className="q-empty">Loading…</div>;
  return <pre className="viewer-text selectable">{text}</pre>;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
