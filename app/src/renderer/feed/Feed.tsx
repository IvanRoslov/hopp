// Feed: the center of a task with a pipeline. Posts, questions and stage
// submissions in time order, a filter by stage, and the line to write to the
// orchestrator. Answered questions are quiet lines; open ones are blocks.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { Artifact, StageState, Task, TaskFeed } from '../../shared/shell';
import type { Ask } from '../../shared/types';
import { ArtifactTile } from '../artifacts/Tile';
import { cleanError } from '../errors';
import { Dropdown } from '../ui/Dropdown';
import { UpIcon } from '../ui/icons';
import { Markdown, type MarkdownLinks } from '../ui/Markdown';
import { plainLine } from '../ui/plainText';
import { DismissAsk, OwnAnswer } from '../questions/AskActions';
import { submissionOptionKind, usableSubmissionOptions } from '../../shared/submission';
import { answerLine, askKind, author, clock, feedEntries, findArtifact, resolveArtifactRef, stageTag, type Entry } from './model';

export interface FeedProps {
  bridge: HoppBridge;
  task: Task;
  feed: TaskFeed;
  loaded: boolean;
  error: string | null;
  reload: () => void;
  stageFilter: string;
  onStageFilter: (s: string) => void;
  onOpenArtifact: (a: Artifact) => void;
  onAllArtifacts: (stageId: string) => void;
  status?: React.ReactNode;
  // The stages as derived from the feed; they name substages.
  stages?: StageState[];
  // Scroll to this ask's block and mark it.
  focusAskId?: number;
  // Scroll to the first entry of this stage (set by the stages panel).
  jump?: { stageId: string; n: number } | null;
}

// MARK_MS: how long the question a jump leads to stays tinted.
export const MARK_MS = 1600;

export function Feed(props: FeedProps) {
  const { task, feed } = props;
  const pipeline = task.pipeline;
  const entries = feedEntries(task, feed, props.stageFilter);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [focused, setFocused] = useState<number | null>(null);

  // Keep the view at the bottom while the human is there, so new entries show.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  useEffect(() => {
    if (!props.focusAskId) return;
    const el = scroller.current?.querySelector(`[data-ask="${props.focusAskId}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    setFocused(props.focusAskId);
    stick.current = false;
    // The mark says "here it is" and then goes.
    const t = setTimeout(() => setFocused(null), MARK_MS);
    return () => clearTimeout(t);
  }, [props.focusAskId, props.loaded]);

  useEffect(() => {
    if (!props.jump) return;
    const el = scroller.current?.querySelector(`[data-stage="${props.jump.stageId}"]`);
    if (el) {
      el.scrollIntoView?.({ block: 'start' });
      stick.current = false;
    }
  }, [props.jump]);

  const stageOptions = [{ value: '', label: 'All feed' }, ...(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))];
  const current = stageOptions.find((o) => o.value === props.stageFilter) ?? stageOptions[0]!;

  return (
    <section className="feed" aria-label="Feed">
      <div
        className="feed-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="feed-col">
          <div className="feed-filter">
            <span className="faint">Feed</span>
            <Dropdown label={current.label} testId="feed-filter" options={stageOptions} value={props.stageFilter} onChange={props.onStageFilter} />
          </div>
          {props.error && (
            <div className="feed-note" role="alert">
              Could not load the feed: {props.error}
              <button type="button" className="c-btn" onClick={props.reload}>
                Retry
              </button>
            </div>
          )}
          {props.loaded && entries.length === 0 && <div className="feed-note">Nothing in this stage yet.</div>}
          {entries.map((e) => (
            <EntryView key={e.key} entry={e} {...props} focused={focused} />
          ))}
        </div>
      </div>
      <div className="feed-foot">
        <div className="feed-col">
          {props.status && <div className="status-line feed-status">{props.status}</div>}
          <Composer bridge={props.bridge} task={task} asks={props.feed.asks} stageFilter={props.stageFilter} onSent={() => {
            stick.current = true;
            props.reload();
          }} />
        </div>
      </div>
    </section>
  );
}

function EntryView(props: FeedProps & { entry: Entry; focused: number | null }) {
  const { entry: e, task } = props;
  // A link or image naming another artifact of the task opens it.
  const links: MarkdownLinks = {
    artifact: (ref) => {
      const x = resolveArtifactRef(props.feed.artifacts, ref);
      return x ? { url: props.bridge.shell.artifactUrl(x.id), open: () => props.onOpenArtifact(x) } : null;
    },
  };
  if (e.kind === 'brief') {
    return (
      <article className="entry">
        <Meta who="You" ts={e.ts} tag="" />
        <Markdown variant="compact" className="entry-body selectable" text={e.body} />
      </article>
    );
  }
  if (e.kind === 'post') {
    const p = e.post;
    const tag = stageTag(p, task.pipeline, props.stages);
    return (
      <article className="entry" data-stage={p.labels['hopp.stage'] ?? undefined}>
        <Meta who={author(p.from, task)} ts={p.created_at} tag={tag} />
        <Markdown variant="compact" className="entry-body selectable" text={p.body} links={links} />
        <Attachments refs={p.attachments} {...props} />
      </article>
    );
  }
  const a = e.ask;
  const kind = askKind(a);
  const tag = stageTag(a, task.pipeline, props.stages);
  const marked = props.focused === a.id;
  if (a.status !== 'open') {
    return (
      <article className="entry quiet" data-ask={a.id} data-stage={a.labels?.['hopp.stage'] ?? undefined}>
        <Meta who={author(a.from, task)} ts={a.created_at} tag={tag} />
        <div className="entry-quiet selectable">
          <Markdown variant="compact" text={a.body} links={links} />
          <div className="entry-answer">
            {a.status !== 'withdrawn' && a.answer?.trim() ? (
              <>
                {'You answered: ' + (a.choice?.trim() ? a.choice + ' — ' : '')}
                <Markdown variant="compact" text={a.answer} links={links} />
              </>
            ) : (
              answerLine(a)
            )}
          </div>
        </div>
      </article>
    );
  }
  return (
    <article className={'entry open' + (marked ? ' marked' : '')} data-ask={a.id} data-stage={a.labels?.['hopp.stage'] ?? undefined} data-testid={`ask-${a.id}`}>
      <Meta who={author(a.from, task)} ts={a.created_at} tag={tag} />
      <Markdown variant="compact" className="entry-body selectable" text={a.body} links={links} />
      <Attachments refs={a.attachments ?? []} {...props} />
      {kind === 'submission' ? (
        <SubmissionBlock ask={a} {...props} />
      ) : kind === 'paid' ? (
        <ChoiceBlock ask={a} options={a.options?.length ? a.options : ['Go', 'Deny']} primary={0} {...props} />
      ) : (
        <ChoiceBlock ask={a} options={a.options ?? []} primary={-1} {...props} />
      )}
    </article>
  );
}

function Meta(props: { who: string; ts: number; tag: string }) {
  return (
    <div className="entry-meta">
      <span>{props.who}</span>
      <span>{clock(props.ts)}</span>
      {props.tag && <span>{props.tag}</span>}
    </div>
  );
}

function Attachments(props: FeedProps & { refs: string[] }) {
  if (!props.refs.length) return null;
  const tiles: Artifact[] = [];
  const other: string[] = [];
  for (const r of props.refs) {
    const a = findArtifact(props.feed.artifacts, r);
    if (a) tiles.push(a);
    else other.push(r);
  }
  return (
    <div className="entry-atts">
      {tiles.length > 0 && (
        <div className={'af-row' + (tiles.length === 1 ? ' one' : '')}>
          {tiles.map((a) => (
            <ArtifactTile key={a.id} shell={props.bridge.shell} artifact={a} onOpen={props.onOpenArtifact} size={tiles.length === 1 ? 'wide' : 'feed'} />
          ))}
        </div>
      )}
      {other.map((r) => (
        <div key={r} className="att-ref mono selectable">
          {r}
        </div>
      ))}
    </div>
  );
}

// SubmissionBlock: the submission's own options, each sending its exact
// text: the first acceptance is the primary button, a return option asks what
// should be fixed first (that text is the answer), any other option is a plain
// button; then All artifacts and Not relevant. A submission whose options hold
// no acceptance is shown as an ordinary question, so no button can fail.
function SubmissionBlock(props: FeedProps & { ask: Ask }) {
  const { ask } = props;
  const options = usableSubmissionOptions(ask);
  const [returning, setReturning] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!options) return <ChoiceBlock {...props} ask={ask} options={ask.options ?? []} primary={-1} />;
  const firstAccept = options.find((o) => submissionOptionKind(o) === 'accept');
  const answer = async (choice: string, why?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await props.bridge.shell.answerSubmission(ask.id, why ? { choice, text: why } : { choice });
      if (!r.ok) setError(r.error.message);
      else props.reload();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.bridge.daemon.dismissAsk(ask.id);
      props.reload();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="entry-actions">
      {returning !== null ? (
        <div className="return-box">
          <textarea
            className="text-input"
            aria-label="What should be fixed?"
            placeholder="What should be fixed?"
            value={text}
            autoFocus
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="btns">
            <button type="button" className="c-btn primary wrap" disabled={busy || !text.trim()} onClick={() => void answer(returning, text.trim())}>
              {returning}
            </button>
            <button type="button" className="c-btn" disabled={busy} onClick={() => setReturning(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="btns submission-btns">
          {options.map((o) => {
            const kind = submissionOptionKind(o);
            return (
              <button
                key={o}
                type="button"
                className={'c-btn wrap' + (o === firstAccept ? ' primary' : '')}
                disabled={busy}
                onClick={() => (kind === 'return' ? setReturning(o) : void answer(o))}
              >
                {o}
              </button>
            );
          })}
          <button type="button" className="c-btn" onClick={() => props.onAllArtifacts(ask.labels?.['hopp.stage'] ?? '')}>
            All artifacts
          </button>
          <span className="sp" />
          <DismissAsk busy={busy} onDismiss={() => void dismiss()} />
        </div>
      )}
      {error && (
        <div className="entry-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ChoiceBlock: an open question with options (a paid Go / Deny, or the
// orchestrator's own choices), or a text answer when it has none.
function ChoiceBlock(props: FeedProps & { ask: Ask; options: string[]; primary: number }) {
  const { ask } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (body: { choice?: string; answer?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await props.bridge.daemon.answerAsk(ask.id, body);
      props.reload();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.bridge.daemon.dismissAsk(ask.id);
      props.reload();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="entry-actions">
      {props.options.length > 0 ? (
        <div className="btns">
          {props.options.map((o, i) => (
            <button key={o} type="button" className={'c-btn wrap' + (i === props.primary ? ' primary' : '')} disabled={busy} onClick={() => void send({ choice: o })}>
              {o}
            </button>
          ))}
          <OwnAnswer busy={busy} onSend={(t) => void send({ answer: t })} />
        </div>
      ) : (
        <div className="inline-field">
          <input
            className="text-input"
            aria-label="Your answer"
            placeholder="Your answer"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim() && !busy) void send({ answer: text.trim() });
            }}
          />
          <button type="button" className="c-btn" disabled={busy || !text.trim()} onClick={() => void send({ answer: text.trim() })}>
            Answer
          </button>
        </div>
      )}
      <div className="ask-dismiss-row">
        <DismissAsk busy={busy} onDismiss={() => void dismiss()} />
      </div>
      {error && (
        <div className="entry-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// Composer: "Write to the orchestrator". Enter sends, Shift+Enter is a new
// line. With a stage filter set, the line is tagged with that stage.
function Composer(props: { bridge: HoppBridge; task: Task; asks: Ask[]; stageFilter: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // With exactly one open question (not a submission or a paid step), the
  // line can go as its answer: on by default, off for this ask once unticked.
  const open = props.asks.filter((a) => a.status === 'open' && askKind(a) === 'question');
  const only = open.length === 1 ? open[0]! : null;
  const [notAnswerTo, setNotAnswerTo] = useState<number | null>(null);
  const asAnswer = only !== null && notAnswerTo !== only.id;
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (asAnswer && only) {
        await props.bridge.daemon.answerAsk(only.id, { answer: t });
        setText('');
        props.onSent();
        return;
      }
      const r = await props.bridge.shell.postToTask(props.task.id, t, props.stageFilter || undefined);
      if (r.ok) {
        setText('');
        props.onSent();
      } else setError(r.error.message);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className="composer">
      <textarea
        aria-label="Write to the orchestrator"
        placeholder="Write to the orchestrator"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={props.task.status === 'finished'}
      />
      <div className="composer-bar">
        {only && (
          <label className="as-answer" title={only.body}>
            <input type="checkbox" checked={asAnswer} onChange={(e) => setNotAnswerTo(e.target.checked ? null : only.id)} />
            <span>Send as the answer to: {plainLine(only.body)}</span>
          </label>
        )}
        {error && (
          <span className="entry-err" role="alert">
            {error}
          </span>
        )}
        <span className="sp" />
        <button type="button" className="c-btn send" aria-label="Send" disabled={busy || !text.trim()} onClick={() => void send()}>
          <UpIcon />
        </button>
      </div>
    </div>
  );
}
