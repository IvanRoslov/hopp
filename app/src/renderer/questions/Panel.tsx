import { useEffect, useState } from 'react';
import { Markdown } from '../ui/Markdown';
import { plainLine } from '../ui/plainText';
import type { DaemonBridge } from '../../shared/bridge';
import type { Ask, Session, SessionQuestion } from '../../shared/types';
import { cleanError } from '../errors';
import { DismissAsk, DISMISSED_LINE, isDismissed, OwnAnswer } from './AskActions';

// How long "Sent" waits for the daemon to report the question resolved
// before it gives the buttons back.
export const SENT_TIMEOUT_MS = 30_000;

// QuestionsPanel: what one session waits on (its screen question and its
// open asks), and below, what was already answered.
export function QuestionsPanel(props: {
  daemon: DaemonBridge;
  session: Session | null;
  sessionId: string;
  asks: Ask[];
  reloadAsks: () => void;
  reloadSession: (id: string) => void;
}) {
  const open = props.asks.filter((a) => a.status === 'open');
  const closed = props.asks.filter((a) => a.status !== 'open').sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const q = props.session?.question;
  return (
    <div className="q-body" data-testid="questions-panel">
      {!q && open.length === 0 && <p className="q-empty">No questions.</p>}
      {q && (
        <HarnessQuestion
          key={props.sessionId + ':' + q.asked_at}
          daemon={props.daemon}
          sessionId={props.sessionId}
          q={q}
          reload={() => props.reloadSession(props.sessionId)}
          lead
        />
      )}
      {open.map((a, i) => (
        <OpenAsk key={a.id} daemon={props.daemon} ask={a} reload={props.reloadAsks} lead={!q && i === 0} />
      ))}
      {closed.length > 0 && (
        <div data-testid="answered">
          <div className="answered-head">You answered</div>
          {closed.map((a) => (
            <AnsweredRow key={a.id} ask={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// Only the first block (`lead`) carries the accent; the rest are neutral.
function HarnessQuestion(props: { daemon: DaemonBridge; sessionId: string; q: SessionQuestion; reload: () => void; lead?: boolean }) {
  const { q, daemon, sessionId } = props;
  const [picked, setPicked] = useState<number[][]>(() => q.questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const oneClick = q.questions.length === 1 && !q.questions[0]!.multi_select;
  const hasOptions = q.questions.some((x) => x.options.length > 0);

  // "Sent" lasts until the question changes (this block remounts), the daemon
  // says it could not confirm the answer, or a time limit passes.
  useEffect(() => {
    if (!sent) return;
    const off = daemon.onEvent((e) => {
      if (e.session_id !== sessionId) return;
      if (e.type === 'session.quiz_answer_unconfirmed') {
        setSent(false);
        setNote('hopp could not confirm the answer. Check the terminal, then answer again if it is still open.');
        props.reload();
      }
    });
    const t = setTimeout(() => {
      setSent(false);
      setNote('No confirmation yet. Check the terminal.');
      props.reload();
    }, SENT_TIMEOUT_MS);
    return () => {
      off();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, daemon, sessionId]);

  const send = async (choice: number[][]) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await daemon.answerQuiz(sessionId, { answers: choice.map((opts, i) => ({ question_index: i, option_indices: opts })) });
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

  return (
    <section className="ask-block" data-testid="harness-question">
      {!hasOptions && (
        <>
          <div className="q">{q.questions.find((x) => x.question)?.question ?? (q.source === 'permission' ? 'Permission requested' : 'The agent waits on its screen')}</div>
          {q.raw && <pre className="raw">{q.raw}</pre>}
          <div className="note">Answer it in the terminal.</div>
        </>
      )}
      {hasOptions &&
        q.questions.map((x, qi) => (
          <div key={qi} className="ask-part">
            <div className="q">{x.question}</div>
            {x.header && x.header !== x.question && <div className="sub">{x.header}</div>}
            <div className="body btns">
              {x.options.map((o, oi) => (
                <button
                  key={oi}
                  type="button"
                  title={o.description}
                  disabled={busy || sent}
                  className={'c-btn' + (props.lead && oneClick && oi === 0 ? ' primary' : '') + (picked[qi]?.includes(oi) ? ' on' : '')}
                  onClick={() => pick(qi, oi)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      {hasOptions && !oneClick && (
        <button type="button" className="c-btn primary" disabled={busy || sent || picked.some((p) => p.length === 0)} onClick={() => void send(picked)}>
          Send
        </button>
      )}
      {sent && <div className="note">Sent. Waiting for the session…</div>}
      {note && !sent && <div className="note">{note}</div>}
      {error && <div className="err" role="alert">{error}</div>}
    </section>
  );
}

// AnsweredRow: one line, cut with an ellipsis; the whole line in the tooltip.
function AnsweredRow(props: { ask: Ask }) {
  const a = props.ask;
  const line =
    plainLine(a.body) +
    ' — ' +
    (a.status === 'answered'
      ? [a.choice, a.answer && plainLine(a.answer)].filter(Boolean).join(' · ')
      : isDismissed(a)
        ? DISMISSED_LINE
        : `withdrawn${a.reason ? ' (' + a.reason.replace(/_/g, ' ') + ')' : ''}`);
  return (
    <div className="answered-row" title={line}>
      {line}
    </div>
  );
}

function OpenAsk(props: { daemon: DaemonBridge; ask: Ask; reload: () => void; lead?: boolean }) {
  const { ask } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = ask.options ?? [];
  // The question's first block as its line; the rest formatted below it.
  const [first, ...rest] = ask.body.split('\n');
  const head = plainLine(first ?? '');

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

  return (
    <section className="ask-block" data-testid={`ask-${ask.id}`}>
      <div className="q">{head}</div>
      {rest.join('\n').trim() && <Markdown variant="compact" className="sub" text={rest.join('\n').trim()} />}
      <div className="body">
        {options.length > 0 ? (
          <div className="btns">
            {options.map((o, i) => (
              <button key={o} type="button" className={'c-btn' + (props.lead && i === 0 ? ' primary' : '')} disabled={busy} onClick={() => void answer({ choice: o })}>
                {o}
              </button>
            ))}
            <OwnAnswer busy={busy} onSend={(t) => void answer({ answer: t })} />
          </div>
        ) : (
          <form
            className="inline-field"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void answer({ answer: text });
            }}
          >
            <input className="text-input" value={text} aria-label="Your answer" placeholder="Your answer" onChange={(e) => setText(e.target.value)} disabled={busy} />
            <button type="submit" className="c-btn" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        )}
      </div>
      <div className="ask-dismiss-row">
        <DismissAsk busy={busy} onDismiss={() => void dismiss()} />
      </div>
      {error && <div className="err" role="alert">{error}</div>}
    </section>
  );
}
