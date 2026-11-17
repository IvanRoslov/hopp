// The question Ivan could not close: options that do not fit, an answer in
// his own words, a line in the feed sent as the answer, and "Not relevant",
// which takes the question out of "Waiting for you" and the task's "waiting
// for me" at once. Set SHOTS_DIR to keep screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeAsk, makeSession } from '../test/fakeDaemon';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

test('dismiss, answer in own words, and answer from the composer', async () => {
  const w = new World();
  const id = 'landing';
  w.seedTask(id, 'Лендинг');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].pipeline = {
    id: 'p', name: 'Site', createdAt: 1, updatedAt: 1,
    stages: [{ id: 'design', name: 'Дизайн', does: '', result: '', substages: false, approval: true }],
  };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession(id, { labels: { 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator' } })];
  const L = (o: Record<string, string> = {}) => ({ 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator', 'hopp.stage': 'design', ...o });
  const now = Math.floor(Date.now() / 1000);
  w.d.posts.push({ id: 1, from: id, labels: L({ 'hopp.event': 'stage_started' }), attachments: [], created_at: now - 400, body: 'Начинаю этап «Дизайн».' });
  w.d.asks.push(
    makeAsk(201, id, { body: 'Какой шрифт для заголовков?', options: ['Inter', 'Roboto', 'Manrope'], labels: L(), created_at: now - 300 }),
  );
  try {
    const page = await w.start();
    await page.setViewportSize({ width: 1400, height: 900 });
    const row = page.getByTestId('task-row').filter({ hasText: 'Лендинг' });
    await expect(row).toContainText('waiting for me', { timeout: 10_000 });
    await page.getByTestId('waiting-row').filter({ hasText: 'шрифт' }).first().click();
    const q = page.getByTestId('ask-201');
    await expect(q).toBeVisible();
    await shot(page, '01-open-question');

    // "Not relevant" asks once, then closes it; the asker is told.
    await q.getByTestId('ask-dismiss').click();
    await expect(q).toContainText('Close this question without an answer?');
    await shot(page, '02-confirm');
    await q.getByTestId('ask-dismiss-confirm').click();
    await expect(page.getByTestId('ask-201')).toHaveCount(0);
    await expect(page.locator('[data-ask="201"]')).toContainText('Dismissed · not relevant');
    await expect(page.getByTestId('waiting-row')).toHaveCount(0);
    await expect(row).not.toContainText('waiting for me');
    expect(w.d.asks[0]).toMatchObject({ status: 'withdrawn', reason: 'dismissed' });
    expect(w.d.messages.at(-1)!.body).toMatch(/^\[hopp\] Ask #201 was dismissed by the human as no longer relevant/);
    await shot(page, '03-dismissed');

    // A new question: answered in Ivan's own words.
    w.d.asks.push(makeAsk(202, id, { body: 'Какой цвет кнопки?', options: ['Зелёный', 'Синий'], labels: L(), created_at: now - 100 }));
    w.d.publish('ask.created', id, { id: 202, ask_labels: L() });
    const q2 = page.getByTestId('ask-202');
    await expect(q2).toBeVisible({ timeout: 10_000 });
    await q2.getByTestId('ask-other').click();
    await q2.getByLabel('Your own answer').fill('Оранжевый, как в брендбуке');
    await shot(page, '04-own-words');
    await q2.getByRole('button', { name: 'Answer' }).click();
    await expect(page.locator('[data-ask="202"]')).toContainText('You answered: Оранжевый, как в брендбуке');
    expect(w.d.asks[1]).toMatchObject({ status: 'answered', answer: 'Оранжевый, как в брендбуке' });

    // One more: the line written to the orchestrator goes as its answer.
    w.d.asks.push(makeAsk(203, id, { body: 'Нужен ли блок с отзывами?', options: ['Да', 'Нет'], labels: L(), created_at: now - 10 }));
    w.d.publish('ask.created', id, { id: 203, ask_labels: L() });
    await expect(page.getByText('Send as the answer to: Нужен ли блок с отзывами?')).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('Write to the orchestrator').fill('Да, но только три отзыва');
    await shot(page, '05-composer-as-answer');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-ask="203"]')).toContainText('You answered: Да, но только три отзыва');
    expect(w.d.asks[2]).toMatchObject({ status: 'answered', answer: 'Да, но только три отзыва' });
    await expect(row).not.toContainText('waiting for me');
  } finally {
    await w.dispose();
  }
});
