import { useState } from 'react';
import type { DaemonBridge } from '../../shared/bridge';
import type { Ask, Session, SessionQuestion } from '../../shared/types';
import { cleanError } from '../errors';
import { DismissAsk, OwnAnswer } from './AskActions';

// questionCount: the session's open asks plus one for a harness question.
export function questionCount(session: Session | null, asks: Ask[]): number {
  if (!session) return 0;
  return asks.filter((a) => a.status === 'open').length + (session.question ? 1 : 0);
}

export function QuestionsButton(props: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <button data-testid="questions-button" className={props.open ? 'active' : ''} onClick={props.onToggle}>
      {props.count > 0 ? `Questions · ${props.count}` : 'Questions'}
    </button>
  );
}

// QuestionsColumn shows what the selected session waits on: the harness
// question, its open asks, and below them the answered ones.
export function QuestionsColumn(props: {
  daemon: DaemonBridge;
  session: Session;
  asks: Ask[];
  reloadAsks: () => void;
  reloadSession: (id: string) => void;
}) {
  const open = props.asks.filter((a) => a.status === 'open');
  const closed = props.asks.filter((a) => a.status !== 'open');
  return (
    <div className="questions">
      <h3>Questions</h3>
      {!props.session.question && open.length === 0 && <p className="muted">No open questions.</p>}
      {props.session.question && (
        <HarnessQuestion
          key={props.session.id + ':' + props.session.question.asked_at}
          daemon={props.daemon}
          sessionId={props.session.id}
          q={props.session.question}
          reload={() => props.reloadSession(props.session.id)}
        />
      )}
      {open.map((a) => (
        <OpenAsk key={a.id} daemon={props.daemon} ask={a} reload={props.reloadAsks} />
      ))}
      {closed.length > 0 && (
        <div data-testid="answered" className="answered">
          <h4>Answered</h4>
          {closed.map((a) => (
            <div key={a.id} className="question-card closed">
              <div className="question-body">{a.body}</div>
              <div className="muted">
                {a.status === 'answered' ? [a.choice, a.answer].filter(Boolean).join(' — ') : `${a.status}${a.reason ? ': ' + a.reason : ''}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HarnessQuestion(props: { daemon: DaemonBridge; sessionId: string; q: SessionQuestion; reload: () => void }) {
  const { q } = props;
  const [picked, setPicked] = useState<number[][]>(() => q.questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oneClick = q.questions.length === 1 && !q.questions[0]!.multi_select;

  const send = async (choice: number[][]) => {
    setBusy(true);
    setError(null);
    try {
      await props.daemon.answerQuiz(props.sessionId, {
        answers: choice.map((opts, i) => ({ question_index: i, option_indices: opts })),
      });
      setSent(true);
    } catch (err) {
      setError(cleanError(err));
      props.reload();
    } finally {
      setBusy(false);
    }
  };

  const pick = (qi: number, oi: number) => {
    if (oneClick) {
      void send([[oi]]);
      return;
    }
    setPicked((p) =>
      p.map((sel, i) => {
        if (i !== qi) return sel;
        if (!q.questions[qi]!.multi_select) return [oi];
        return sel.includes(oi) ? sel.filter((x) => x !== oi) : [...sel, oi].sort((a, b) => a - b);
      }),
    );
  };

  const hasOptions = q.questions.some((x) => x.options.length > 0);
  return (
    <div className="question-card" data-testid="harness-question">
      <div className="question-kind muted">{q.source === 'permission' ? 'Permission' : 'Harness question'}</div>
      {!hasOptions && (
        <>
          {q.questions.map((x, i) => (
            <div key={i} className="question-body">{x.question}</div>
          ))}
          {q.raw && <pre className="question-raw">{q.raw}</pre>}
          <div className="muted">Answer it in the terminal.</div>
        </>
      )}
      {hasOptions &&
        q.questions.map((x, qi) => (
          <div key={qi} className="question-part">
            {x.header && <div className="muted">{x.header}</div>}
            <div className="question-body">{x.question}</div>
            <div className="question-options">
              {x.options.map((o, oi) => (
                <button
                  key={oi}
                  title={o.description}
                  disabled={busy || sent}
                  className={picked[qi]?.includes(oi) ? 'active' : ''}
                  onClick={() => pick(qi, oi)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      {hasOptions && !oneClick && (
        <button disabled={busy || sent || picked.some((p) => p.length === 0)} onClick={() => void send(picked)}>
          Send
        </button>
      )}
      {sent && <div className="muted">Sent. Waiting for the session…</div>}
      {error && <div className="question-error">{error}</div>}
    </div>
  );
}

function OpenAsk(props: { daemon: DaemonBridge; ask: Ask; reload: () => void }) {
  const { ask } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (body: { choice?: string; answer?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await props.daemon.answerAsk(ask.id, body);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
      props.reload();
    }
  };
  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.daemon.dismissAsk(ask.id);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
      props.reload();
    }
  };

  const options = ask.options ?? [];
  return (
    <div className="question-card" data-testid={`ask-${ask.id}`}>
      <div className="question-kind muted">Ask #{ask.id}</div>
      <div className="question-body">{ask.body}</div>
      {options.length > 0 ? (
        <div className="question-options">
          {options.map((o) => (
            <button key={o} disabled={busy} onClick={() => void answer({ choice: o })}>
              {o}
            </button>
          ))}
          <OwnAnswer busy={busy} onSend={(t) => void answer({ answer: t })} />
        </div>
      ) : (
        <form
          className="question-text"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void answer({ answer: text });
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      )}
      <DismissAsk busy={busy} onDismiss={() => void dismiss()} />
      {error && <div className="question-error">{error}</div>}
    </div>
  );
}
