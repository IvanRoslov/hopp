// StagesPanel: the pipeline's stages with their derived state, substages and
// the artifacts of each substage. A row leads to its place in the feed; a
// submitted stage leads to its submission block.
import { Markdown } from '../ui/Markdown';
import { useEffect, useState } from 'react';
import type { Artifact, Pipeline, ShellBridge, StageState, StageStatus } from '../../shared/shell';
import { LABEL } from '../../shared/shell';
import { ArtifactTile } from '../artifacts/Tile';
import { CheckIcon, DownIcon } from '../ui/icons';

const WORD: Record<StageStatus, string> = {
  not_started: 'not started',
  started: 'in progress',
  submitted: 'waiting for you',
  accepted: 'accepted',
  returned: 'returned',
};

function Mark(props: { status: StageStatus }) {
  if (props.status === 'accepted') return <span className="st-mark done"><CheckIcon /></span>;
  if (props.status === 'submitted') return <span className="st-mark wait" aria-hidden><i /></span>;
  if (props.status === 'not_started') return <span className="st-mark idle" aria-hidden><span className="ring" /></span>;
  return <span className="st-mark busy" aria-hidden><span className="ring dot" /></span>;
}

// latest version of each name among artifacts with these labels
function latestOf(artifacts: Artifact[], stageId: string, substage?: string): Artifact[] {
  const m = new Map<string, Artifact>();
  for (const a of artifacts) {
    if (a.labels[LABEL.stage] !== stageId) continue;
    if (substage !== undefined && a.labels[LABEL.substage] !== substage) continue;
    if ((m.get(a.name)?.version ?? 0) < a.version) m.set(a.name, a);
  }
  return [...m.values()];
}

export function StagesPanel(props: {
  shell: ShellBridge;
  pipeline: Pipeline;
  states: StageState[];
  artifacts: Artifact[];
  onJump: (stageId: string) => void;
  onOpenSubmission: (askId: number) => void;
  onOpenArtifact: (a: Artifact) => void;
}) {
  const { pipeline, states } = props;
  // The stage in progress (or waiting) starts open; the human's toggles win.
  const current = states.find((s) => s.status === 'submitted' || s.status === 'started' || s.status === 'returned')?.stageId ?? '';
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? [current] : []));
  const [openSub, setOpenSub] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (current) setOpen((o) => (o.has(current) ? o : new Set([...o, current])));
  }, [current]);
  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };
  const anyOpen = open.size > 0;

  return (
    <div className="stages" data-testid="stages-panel">
      <div className="stages-tools">
        <button type="button" className="c-btn" onClick={() => setOpen(anyOpen ? new Set() : new Set(pipeline.stages.map((s) => s.id)))}>
          {anyOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <ol className="stage-list">
        {pipeline.stages.map((stage, i) => {
          const st = states[i]!;
          const isOpen = open.has(stage.id);
          const isCurrent = stage.id === current;
          const loose = latestOf(props.artifacts, stage.id).filter((a) => !a.labels[LABEL.substage]);
          return (
            <li key={stage.id} className={'stage' + (isCurrent ? ' current' : '')} data-testid={`stage-${stage.id}`}>
              <div className="stage-row">
                <button
                  type="button"
                  className={'chev' + (isOpen ? ' open' : '')}
                  aria-label={(isOpen ? 'Collapse ' : 'Expand ') + stage.name}
                  aria-expanded={isOpen}
                  onClick={() => setOpen((o) => toggle(o, stage.id))}
                >
                  <DownIcon />
                </button>
                <Mark status={st.status} />
                <button type="button" className="stage-name" onClick={() => props.onJump(stage.id)}>
                  {stage.name}
                </button>
                <span className={'stage-word' + (st.status === 'submitted' ? ' wait' : '')}>{WORD[st.status]}</span>
              </div>
              {isOpen && (
                <div className="stage-body">
                  {stage.does && <Markdown variant="compact" className="stage-text" text={stage.does} />}
                  {loose.length > 0 && (
                    <div className="sub-arts loose">
                      {loose.map((a) => (
                        <ArtifactTile key={a.id} shell={props.shell} artifact={a} onOpen={props.onOpenArtifact} size="feed" />
                      ))}
                    </div>
                  )}
                  {st.substages.map((sub) => {
                    const key = stage.id + '/' + sub.slug;
                    const so = openSub.has(key);
                    const arts = latestOf(props.artifacts, stage.id, sub.slug);
                    return (
                      <div key={sub.slug} className="substage">
                        <div className="stage-row sub">
                          <button
                            type="button"
                            className={'chev' + (so ? ' open' : '')}
                            aria-label={(so ? 'Collapse ' : 'Expand ') + sub.title}
                            aria-expanded={so}
                            onClick={() => setOpenSub((o) => toggle(o, key))}
                          >
                            <DownIcon />
                          </button>
                          <span className="stage-name plain">{sub.title}</span>
                        </div>
                        {so && (
                          <div className="sub-arts">
                            {arts.length === 0 ? <span className="faint">No artifacts yet.</span> : arts.map((a) => (
                              <ArtifactTile key={a.id} shell={props.shell} artifact={a} onOpen={props.onOpenArtifact} size="feed" />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {st.submission && (
                    <button type="button" className="link-btn stage-link" onClick={() => props.onOpenSubmission(st.submission!.id)}>
                      Submitted · waiting for approval
                    </button>
                  )}
                  {st.status === 'returned' && st.lastAnswer?.answer && (
                    <div className="stage-text">
                      Returned:
                      <Markdown variant="compact" text={st.lastAnswer.answer} />
                    </div>
                  )}
                  <p className="stage-flags">
                    {stage.approval ? 'Waits for approval.' : 'Passes without approval.'} The agent always asks before paid actions.
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
