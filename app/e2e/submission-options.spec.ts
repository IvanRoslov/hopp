// A submission with the orchestrator's own options (three kinds of Accept and
// Return, long Cyrillic sentences): every option is a button with its full
// text, the first Accept variant is primary, and a press sends that exact
// text, so the daemon accepts it and the stage is accepted. Set SHOTS_DIR to
// keep screenshots.
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

const OPTIONS = ['Accept: открыть PR и влить все три (app, toolkit-fix, vault)', 'Accept: только открыть PR, сливаю сам', 'Accept: оставить ветки как есть', 'Return'];

test('a submission with its own Accept variants is answered with the exact option', async () => {
  const w = new World();
  const id = 'release';
  w.seedTask(id, 'Релиз');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].pipeline = {
    id: 'p', name: 'Dev', createdAt: 1, updatedAt: 1,
    stages: [{ id: 'verify', name: 'Проверка', does: '', result: '', substages: false, approval: true }],
  };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession(id, { labels: { 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator' } })];
  const L = (o: Record<string, string> = {}) => ({ 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator', 'hopp.stage': 'verify', ...o });
  const now = Math.floor(Date.now() / 1000);
  w.d.posts.push({ id: 1, from: id, labels: L({ 'hopp.event': 'stage_started' }), attachments: [], created_at: now - 400, body: 'Начинаю этап «Проверка».' });
  w.d.asks.push(makeAsk(22, id, {
    body: 'Этап «Проверка» готов: все тесты зелёные, ветки app, toolkit-fix и vault готовы к слиянию. Что сделать с ветками?',
    options: OPTIONS, labels: L({ 'hopp.kind': 'submission' }), created_at: now - 100,
  }));
  try {
    const page = await w.start();
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.getByTestId('waiting-row').filter({ hasText: 'Проверка' }).first().click();
    const block = page.getByTestId('ask-22');
    await expect(block).toBeVisible({ timeout: 10_000 });
    for (const o of OPTIONS) await expect(block.getByRole('button', { name: o, exact: true })).toBeVisible();
    await expect(block.getByRole('button', { name: OPTIONS[0]!, exact: true })).toHaveClass(/primary/);
    await shot(page, '01-four-options');
    // Narrow: the sentences wrap inside the feed, nothing overflows.
    await page.setViewportSize({ width: 900, height: 900 });
    expect(await block.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await shot(page, '02-narrow');
    await page.setViewportSize({ width: 1300, height: 900 });

    await block.getByRole('button', { name: OPTIONS[1]!, exact: true }).click();
    await expect(page.locator('[data-ask="22"]')).toContainText('You answered: ' + OPTIONS[1]);
    expect(w.d.asks[0]).toMatchObject({ status: 'answered', choice: OPTIONS[1] });
    await page.getByTestId('stages-button').click();
    await expect(page.getByText('Accepted').first()).toBeVisible();
    await shot(page, '03-accepted');
  } finally {
    await w.dispose();
  }
});
