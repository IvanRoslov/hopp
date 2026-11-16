// A task's questions: they arrive without resizing the terminal, opening the
// column may resize it, and every answer goes to the daemon.
import { expect, test } from '@playwright/test';
import { makeAsk, makeSession } from '../test/fakeDaemon';
import { World } from './world';

test('questions arrive without resizing the terminal; answers go to the daemon', async () => {
  const w = new World();
  w.seedTask('a', 'Ship the header');
  w.d.sessions = [makeSession('a', { labels: { 'hopp.task': 'a', 'hopp.role': 'orchestrator' } })];
  // The shell prints a line on every SIGWINCH, i.e. every pty resize.
  w.d.defaultAttach = ['/bin/sh', '-c', 'trap "echo WINCH-SEEN" WINCH; echo ready; while :; do sleep 0.1; done'];
  try {
    const page = await w.start();
    await page.getByTestId('task-row').filter({ hasText: 'Ship the header' }).click();
    const screen = page.locator('.xterm-rows');
    await expect(screen).toContainText('ready', { timeout: 15_000 });
    await page.waitForTimeout(500);
    const winchBefore = ((await screen.textContent()) ?? '').split('WINCH-SEEN').length;

    // A harness question and two asks arrive; a worker appears.
    w.d.setSession(makeSession('a', {
      labels: { 'hopp.task': 'a', 'hopp.role': 'orchestrator' }, activity: 'waiting_input',
      question: { asked_at: 5, questions: [{ question: 'Pick one', header: 'Pick', multi_select: false, options: [{ label: 'left' }, { label: 'right' }] }] },
    }));
    w.d.publish('session.quiz_asked', 'a');
    w.d.asks.push(makeAsk(1, 'a', { body: 'Ship it?', options: ['yes', 'no'] }), makeAsk(2, 'a', { body: 'Second?', options: ['ok'] }));
    w.d.publish('ask.created', 'a', { id: 1 });
    w.d.publish('ask.created', 'a', { id: 2 });
    w.d.setSession(makeSession('b', { parent: 'a' }));
    w.d.publish('session.spawned', 'b');
    await expect(page.getByTestId('questions-button')).toHaveText('Questions · 3', { timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(((await screen.textContent()) ?? '').split('WINCH-SEEN').length).toBe(winchBefore);

    // Opening the column is allowed to resize, and does.
    await page.getByTestId('questions-button').click();
    await expect(page.getByTestId('zone-middle')).toBeVisible();
    await expect(screen).toContainText('WINCH-SEEN');

    // Answer an ask.
    await page.getByTestId('ask-1').getByRole('button', { name: 'yes' }).click();
    await expect(page.getByTestId('answered')).toContainText('Ship it?');
    expect(w.d.asks[0]).toMatchObject({ status: 'answered', choice: 'yes' });

    // A conflict shows the daemon's message in place.
    w.d.override.set('POST /v1/asks/2/answer', { status: 409, body: { error: { code: 'ask_closed', message: 'the ask is no longer open' } } });
    await page.getByTestId('ask-2').getByRole('button', { name: 'ok' }).click();
    await expect(page.getByTestId('ask-2')).toContainText('the ask is no longer open');

    // Answer the harness question.
    await page.getByTestId('harness-question').getByRole('button', { name: 'right' }).click();
    await expect(page.getByTestId('harness-question')).toContainText('Sent.');
    const quiz = w.d.requests.find((r) => r.url === '/v1/sessions/a/quiz/answer')!;
    expect(JSON.parse(quiz.body)).toEqual({ answers: [{ question_index: 0, option_indices: [1] }] });
  } finally {
    await w.dispose();
  }
});
