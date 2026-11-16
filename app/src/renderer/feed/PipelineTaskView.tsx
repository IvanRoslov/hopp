// PipelineTaskView: a task with a pipeline. The feed stays in the center; the
// header opens Stages, Artifacts or the Terminal in a column on the right.
// Questions of such a task live in the feed, so there is no questions column.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { Artifact, Task } from '../../shared/shell';
import { deriveStages } from '../../shared/stages';
import { ArtifactsPanel } from '../artifacts/ArtifactsPanel';
import { StagesPanel } from '../stages/StagesPanel';
import { CloseIcon } from '../ui/icons';
import { Feed } from './Feed';
import { useTaskFeed } from './useTaskFeed';
import './feed.css';

export type PipelinePanel = 'stages' | 'artifacts' | 'terminal' | 'details';

export interface PipelineTaskViewProps {
  bridge: HoppBridge;
  task: Task;
  menu: ReactNode;
  terminal: ReactNode;
  details: ReactNode;
  status?: ReactNode;
  panel: PipelinePanel | null;
  onPanel: (p: PipelinePanel | null) => void;
  focusAskId?: number;
}

const TITLES: Record<PipelinePanel, string> = { stages: 'Stages', artifacts: 'Artifacts', terminal: 'Terminal', details: 'Details' };

const TermIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path d="M3 4.5 6.5 8 3 11.5M8.5 11.5H13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function PipelineTaskView(props: PipelineTaskViewProps) {
  const { bridge, task } = props;
  const shell = bridge.shell;
  const { feed, loaded, error, reload } = useTaskFeed(shell, task.id);
  const [feedStage, setFeedStage] = useState('');
  const [artStage, setArtStage] = useState('');
  const [viewing, setViewing] = useState<Artifact | null>(null);
  const [focus, setFocus] = useState<number | undefined>(props.focusAskId);
  const [jump, setJump] = useState<{ stageId: string; n: number } | null>(null);
  const states = useMemo(() => (task.pipeline ? deriveStages(task.pipeline, feed.posts, feed.asks) : []), [task.pipeline, feed]);
  const waiting = states.filter((s) => s.status === 'submitted').length;

  // The focus prop comes from "Waiting for you"; a click inside moves it.
  useEffect(() => setFocus(props.focusAskId), [props.focusAskId]);
  const toggle = (p: PipelinePanel) => props.onPanel(props.panel === p ? null : p);
  const openArtifact = (a: Artifact) => {
    setViewing(a);
    props.onPanel('artifacts');
  };
  const openSubmission = (askId: number) => {
    setFeedStage('');
    setFocus(askId);
    setJump(null);
  };
  const open = props.panel !== null;

  const panelBody = (() => {
    switch (props.panel) {
      case 'stages':
        return task.pipeline ? (
          <StagesPanel
            shell={shell}
            pipeline={task.pipeline}
            states={states}
            artifacts={feed.artifacts}
            onJump={(stageId) => {
              setFeedStage('');
              setJump({ stageId, n: Date.now() });
            }}
            onOpenSubmission={openSubmission}
            onOpenArtifact={openArtifact}
          />
        ) : null;
      case 'artifacts':
        return (
          <ArtifactsPanel
            shell={shell}
            pipeline={task.pipeline}
            artifacts={feed.artifacts}
            asks={feed.asks}
            stageFilter={artStage}
            onStageFilter={setArtStage}
            viewing={viewing}
            onView={setViewing}
            onOpenSubmission={openSubmission}
          />
        );
      case 'terminal':
        return <div className="pt-term">{props.terminal}</div>;
      case 'details':
        return <div className="q-body">{props.details}</div>;
      default:
        return null;
    }
  })();

  return (
    <div className={'ptask' + (open ? ' open' : '')} data-testid="pipeline-task-view">
      <div className="top ptask-top">
        <span className="name" title={task.title}>
          {task.title}
        </span>
        <span className="sp" />
        <button
          type="button"
          className={'c-btn' + (props.panel === 'stages' ? ' on' : '')}
          aria-pressed={props.panel === 'stages'}
          data-testid="stages-button"
          onClick={() => toggle('stages')}
        >
          {waiting > 0 ? `Stages · ${waiting}` : 'Stages'}
        </button>
        <button
          type="button"
          className={'c-btn' + (props.panel === 'artifacts' ? ' on' : '')}
          aria-pressed={props.panel === 'artifacts'}
          data-testid="artifacts-button"
          onClick={() => {
            setViewing(null);
            toggle('artifacts');
          }}
        >
          Artifacts
        </button>
        {props.menu}
        <button
          type="button"
          className={'c-btn' + (props.panel === 'terminal' ? ' on' : '')}
          aria-pressed={props.panel === 'terminal'}
          data-testid="terminal-button"
          onClick={() => toggle('terminal')}
        >
          <TermIcon />
          Terminal
        </button>
      </div>
      <div className="ptask-feed">
        <Feed
          bridge={bridge}
          task={task}
          feed={feed}
          loaded={loaded}
          error={error}
          reload={() => void reload()}
          stageFilter={feedStage}
          onStageFilter={setFeedStage}
          onOpenArtifact={openArtifact}
          onAllArtifacts={(stageId) => {
            setViewing(null);
            setArtStage(stageId);
            props.onPanel('artifacts');
          }}
          status={props.status}
          focusAskId={focus}
          jump={jump}
        />
      </div>
      {open && <div className="task-div" aria-hidden />}
      {open && props.panel && (
        <section className="ptask-panel" aria-label={TITLES[props.panel]} data-testid="pipeline-panel">
          <div className="q-head">
            <span>{TITLES[props.panel]}</span>
            <span className="sp" />
            <button type="button" className="c-btn icon" aria-label="Close the column" onClick={() => props.onPanel(null)}>
              <CloseIcon />
            </button>
          </div>
          <div className="ptask-panel-body">{panelBody}</div>
        </section>
      )}
    </div>
  );
}
