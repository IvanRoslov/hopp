// ArtifactThumb and ArtifactTile: the picture of an artifact version used in
// the feed and the artifacts panel. Images and video show the file itself;
// HTML, text and other files show a calm placeholder drawn in CSS.
import type { Artifact, ShellBridge } from '../../shared/shell';
import { artifactKind, KIND_WORD } from '../feed/model';

export function ArtifactThumb(props: { shell: ShellBridge; artifact: Artifact }) {
  const { artifact: a } = props;
  const kind = artifactKind(a);
  if (kind === 'image') return <img className="af-thumb" src={props.shell.artifactUrl(a.id)} alt="" draggable={false} loading="lazy" />;
  if (kind === 'video') {
    return (
      <span className="af-thumb af-video">
        <video src={props.shell.artifactUrl(a.id) + '#t=0.5'} muted preload="metadata" />
        <span className="af-play" aria-hidden />
      </span>
    );
  }
  return (
    <span className={'af-thumb af-ph af-' + kind} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export function ArtifactTile(props: {
  shell: ShellBridge;
  artifact: Artifact;
  onOpen: (a: Artifact) => void;
  size?: 'feed' | 'grid' | 'wide';
  submitted?: boolean;
  showKind?: boolean;
}) {
  const a = props.artifact;
  const sub = (props.showKind ? `${KIND_WORD[artifactKind(a)]} · version ${a.version}` : `Version ${a.version}`) + (props.submitted ? ' · submitted' : '');
  return (
    <button
      type="button"
      className={'af-tile af-' + (props.size ?? 'feed')}
      title={`${a.name}@${a.version} — ${a.filename}`}
      onClick={() => props.onOpen(a)}
      data-testid={`artifact-tile-${a.name}@${a.version}`}
    >
      <ArtifactThumb shell={props.shell} artifact={a} />
      <span className="af-cap">
        <span className="af-name">{a.name}</span>
        <span className="af-sub">{sub}</span>
      </span>
    </button>
  );
}
