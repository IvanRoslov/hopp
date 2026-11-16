import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge } from '../../../test/bridge';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';
import type { SessionQuestion } from '../../shared/types';

vi.mock('../terminal/Terminal', () => ({
  Terminal: (p: { sessionId: string }) => <div data-testid="terminal">terminal:{p.sessionId}</div>,
}));

const { Workspace } = await import('../Workspace');

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

const oneQuestion: SessionQuestion = {
  asked_at: 1,
  questions: [{ question: 'Which file?', header: 'File', multi_select: false, options: [{ label: 'a.go' }, { label: 'b.go' }] }],
};

async function openSession(f: ReturnType<typeof fakeBridge>, id = 'a') {
  render(<Workspace bridge={f.bridge} />);
  await flush();
  fireEvent.click(screen.getAllByTestId('session-row').find((r) => r.dataset['id'] === id)!);
  await flush();
}

const button = () => screen.getByTestId('questions-button');

afterEach(cleanup);

describe('Questions', () => {
  it('the button counts open asks plus the harness question, and has no number without them', async () => {
    const f = fakeBridge({
      sessions: [makeSession('a', { question: oneQuestion }), makeSession('b')],
      asks: [makeAsk(1, 'a'), makeAsk(2, 'a'), makeAsk(3, 'b'), makeAsk(4, 'a', { status: 'answered' })],
    });
    await openSession(f, 'a');
    expect(button().textContent).toBe('Questions · 3');
    fireEvent.click(screen.getAllByTestId('session-row')[1]!);
    await flush();
    expect(button().textContent).toBe('Questions · 1');
    f.db.asks = f.db.asks.filter((x) => x.from !== 'b');
    f.emit('ask.withdrawn', 'b', { id: 3 });
    await flush();
    expect(button().textContent).toBe('Questions');
  });

  it('a new ask from the session raises the count', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    await openSession(f);
    expect(button().textContent).toBe('Questions');
    f.db.asks.push(makeAsk(9, 'a'));
    f.emit('ask.created', 'a', { id: 9 });
    await flush();
    expect(button().textContent).toBe('Questions · 1');
  });

  it('the button opens and closes the column between the list and the terminal', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    await openSession(f);
    expect(screen.queryByTestId('zone-middle')).toBeNull();
    fireEvent.click(button());
    expect(screen.getByTestId('zone-middle')).toBeTruthy();
    fireEvent.click(button());
    expect(screen.queryByTestId('zone-middle')).toBeNull();
  });

  it('answers an ask with an option, then lists it as answered', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')], asks: [makeAsk(1, 'a', { body: 'Ship it?', options: ['yes', 'no'] })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    const ask = screen.getByTestId('ask-1');
    expect(ask.textContent).toContain('Ship it?');
    fireEvent.click(within(ask).getByRole('button', { name: 'yes' }));
    await flush();
    expect(f.daemon.answerAsk).toHaveBeenCalledWith(1, { choice: 'yes' });
    f.emit('ask.answered', 'a', { id: 1 });
    await flush();
    const answered = screen.getByTestId('answered');
    expect(answered.textContent).toContain('Ship it?');
    expect(answered.textContent).toContain('yes');
    expect(button().textContent).toBe('Questions');
  });

  it('answers an ask without options with text', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')], asks: [makeAsk(2, 'a', { body: 'Name?', options: null })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    const ask = screen.getByTestId('ask-2');
    fireEvent.change(within(ask).getByRole('textbox'), { target: { value: 'hopp' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Send' }));
    await flush();
    expect(f.daemon.answerAsk).toHaveBeenCalledWith(2, { answer: 'hopp' });
  });

  it('answers a single harness question with one click', async () => {
    const f = fakeBridge({ sessions: [makeSession('a', { question: oneQuestion })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    const q = screen.getByTestId('harness-question');
    expect(q.textContent).toContain('Which file?');
    fireEvent.click(within(q).getByRole('button', { name: 'b.go' }));
    await flush();
    expect(f.daemon.answerQuiz).toHaveBeenCalledWith('a', { answers: [{ question_index: 0, option_indices: [1] }] });
  });

  it('several harness questions are sent together', async () => {
    const quiz: SessionQuestion = {
      asked_at: 1,
      questions: [
        { question: 'Q1', header: 'H1', multi_select: false, options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'Q2', header: 'H2', multi_select: true, options: [{ label: 'p' }, { label: 'q' }, { label: 'r' }] },
      ],
    };
    const f = fakeBridge({ sessions: [makeSession('a', { question: quiz })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    const q = screen.getByTestId('harness-question');
    const send = within(q).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(q).getByRole('button', { name: 'y' }));
    fireEvent.click(within(q).getByRole('button', { name: 'p' }));
    fireEvent.click(within(q).getByRole('button', { name: 'r' }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await flush();
    expect(f.daemon.answerQuiz).toHaveBeenCalledWith('a', {
      answers: [
        { question_index: 0, option_indices: [1] },
        { question_index: 1, option_indices: [0, 2] },
      ],
    });
  });

  it('a question with no options shows its raw text', async () => {
    const quiz: SessionQuestion = { asked_at: 1, source: 'permission', raw: 'Allow edit of a.go?\n1. Yes\n2. No', questions: [] };
    const f = fakeBridge({ sessions: [makeSession('a', { question: quiz })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    expect(screen.getByTestId('harness-question').textContent).toContain('Allow edit of a.go?');
  });

  it('a failed ask answer shows the daemon message in place and reloads', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')], asks: [makeAsk(1, 'a', { options: ['yes'] })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    const loads = f.daemon.listAsks.mock.calls.length;
    f.daemon.answerAsk.mockRejectedValueOnce(
      new Error("Error invoking remote method 'daemon:answer-ask': DaemonError: the ask is no longer open"),
    );
    fireEvent.click(within(screen.getByTestId('ask-1')).getByRole('button', { name: 'yes' }));
    await flush();
    expect(screen.getByTestId('ask-1').textContent).toContain('the ask is no longer open');
    expect(f.daemon.listAsks.mock.calls.length).toBeGreaterThan(loads);
  });

  it('a failed harness answer shows the message and reloads the session', async () => {
    const f = fakeBridge({ sessions: [makeSession('a', { question: oneQuestion })] });
    await openSession(f);
    fireEvent.click(button());
    await flush();
    f.daemon.answerQuiz.mockRejectedValueOnce(
      new Error("Error invoking remote method 'daemon:answer-quiz': DaemonError: session has no pending quiz"),
    );
    f.daemon.getSession.mockClear();
    fireEvent.click(within(screen.getByTestId('harness-question')).getByRole('button', { name: 'a.go' }));
    await flush();
    expect(screen.getByTestId('harness-question').textContent).toContain('session has no pending quiz');
    expect(f.daemon.getSession).toHaveBeenCalledWith('a');
  });
});
