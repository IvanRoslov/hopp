import { expect, test } from '@playwright/test';
import { FakeDaemon, makeAsk, makeSession } from '../test/fakeDaemon';
import { launchApp } from './launch';

test('questions arrive without resizing the terminal; answers go to the daemon', async () => {
  const d = new FakeDaemon();
  await d.start();
  d.sessions = [makeSession('a')];
  // The shell prints a line on every SIGWINCH, i.e. every pty resize.
  d.defaultAttach = ['/bin/sh', '-c', 'trap "echo WINCH-SEEN" WINCH; echo ready; while :; do sleep 0.1; done'];
  const app = await launchApp({ HOPP_HOME: d.home });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('session-row').first().click();
    const screen = page.locator('.xterm-rows');
    await expect(screen).toContainText('ready');
    // Let the first layout settle before measuring.
    await page.waitForTimeout(500);
    const winchBefore = ((await screen.textContent()) ?? '').split('WINCH-SEEN').length;

    // A harness question and two asks arrive; another session appears.
    d.setSession(makeSession('a', {
      activity: 'waiting_input',
      question: { asked_at: 5, questions: [{ question: 'Pick one', header: 'Pick', multi_select: false, options: [{ label: 'left' }, { label: 'right' }] }] },
    }));
    d.publish('session.quiz_asked', 'a');
    d.asks.push(makeAsk(1, 'a', { body: 'Ship it?', options: ['yes', 'no'] }), makeAsk(2, 'a', { body: 'Second?', options: ['ok'] }));
    d.publish('ask.created', 'a', { id: 1 });
    d.publish('ask.created', 'a', { id: 2 });
    d.setSession(makeSession('b'));
    d.publish('session.spawned', 'b');
    await expect(page.getByTestId('questions-button')).toHaveText('Questions · 3');
    await expect(page.getByTestId('session-row')).toHaveCount(2);
    await page.waitForTimeout(1000);
    expect(((await screen.textContent()) ?? '').split('WINCH-SEEN').length).toBe(winchBefore);

    // Opening the column is allowed to resize, and does.
    await page.getByTestId('questions-button').click();
    await expect(page.getByTestId('zone-middle')).toBeVisible();
    await expect(screen).toContainText('WINCH-SEEN');

    // Answer an ask.
    await page.getByTestId('ask-1').getByRole('button', { name: 'yes' }).click();
    await expect(page.getByTestId('answered')).toContainText('Ship it?');
    expect(d.asks[0]).toMatchObject({ status: 'answered', choice: 'yes' });

    // A conflict shows the daemon's message in place.
    d.override.set('POST /v1/asks/2/answer', { status: 409, body: { error: { code: 'ask_closed', message: 'the ask is no longer open' } } });
    await page.getByTestId('ask-2').getByRole('button', { name: 'ok' }).click();
    await expect(page.getByTestId('ask-2')).toContainText('the ask is no longer open');

    // Answer the harness question.
    await page.getByTestId('harness-question').getByRole('button', { name: 'right' }).click();
    await expect(page.getByTestId('harness-question')).toContainText('Sent.');
    const quiz = d.requests.find((r) => r.url === '/v1/sessions/a/quiz/answer')!;
    expect(JSON.parse(quiz.body)).toEqual({ answers: [{ question_index: 0, option_indices: [1] }] });
  } finally {
    await app.close().catch(() => {});
    await d.dispose();
  }
});
