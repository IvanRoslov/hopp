// An open question in the feed (a stage submission, a paid ask, an ordinary
// one) reached from "Waiting for you": one layer at most, inner padding when
// it is drawn, its text on the feed's text column, and the mark of the jump
// fading after a moment. Set SHOTS_DIR to keep screenshots.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Post } from '../src/shared/shell';
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

// What the card draws: its padding, how many frames (border + ring shadows),
// and where its body text starts against the feed's column.
async function card(block: Locator) {
  return block.evaluate((el) => {
    const cs = getComputedStyle(el);
    const col = el.closest('.feed-col')!.getBoundingClientRect();
    const body = el.querySelector('.entry-body')!.getBoundingClientRect();
    const meta = el.querySelector('.entry-meta')!.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const borders = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0).length;
    const rings = cs.boxShadow === 'none' ? 0 : cs.boxShadow.split(/,(?![^(]*\))/).length;
    const tinted = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
    return {
      padding: ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs.getPropertyValue(`padding-${s.toLowerCase()}`))),
      frames: (borders > 0 ? 1 : 0) + rings,
      tinted,
      bodyOnColumn: Math.abs(body.left - col.left) < 1,
      metaInside: meta.top - rect.top,
    };
  });
}

test('an open question reached from Waiting for you is one calm block', async () => {
  const w = new World();
  const id = 'site-design';
  w.seedTask(id, 'Дизайн лендинга');
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
  const dir = join(w.home, 'artifacts', id, 'spec', 'v2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), '# Спека\n');
  for (const v of [1, 2]) {
    w.d.artifacts.push({
      id: v, scope: id, name: 'spec', version: v, filename: 'spec.md', mime: 'text/markdown', size: 8, sha256: '', from: id, labels: L(),
      created_at: now - 300 + v, path: join(dir, 'spec.md'),
    });
  }
  for (const [i, name] of ['palette', 'grid'].entries()) {
    const d2 = join(w.home, 'artifacts', id, name, 'v1');
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, name + '.md'), '# ' + name + '\n');
    w.d.artifacts.push({
      id: 3 + i, scope: id, name, version: 1, filename: name + '.md', mime: 'text/markdown', size: 8, sha256: '', from: id, labels: L(),
      created_at: now - 250 + i, path: join(d2, name + '.md'),
    });
  }
  const post: Post = { id: 1, from: id, labels: L({ 'hopp.event': 'stage_started' }), attachments: [], created_at: now - 400, body: 'Начинаю этап «Дизайн».' };
  w.d.posts.push(post);
  w.d.asks.push(
    makeAsk(101, id, {
      body: 'Этап «Дизайн» готов. Спека описывает **сетку**, типографику и цвета:\n\n- сетка 12 колонок, `max-width: 1200px`;\n- шрифт **Inter**, кириллица проверена;\n- две темы.',
      options: ['Accept', 'Return'], attachments: ['spec@2', 'palette@1', 'grid@1'], labels: L({ 'hopp.kind': 'submission' }), created_at: now - 200,
    }),
    makeAsk(102, id, { body: 'Сгенерировать 4 макета в Figma? Это 2 кредита.', options: ['Go', 'Deny'], labels: L({ 'hopp.kind': 'paid' }), created_at: now - 100 }),
    makeAsk(103, id, { body: 'Какой акцентный цвет взять?', options: ['Зелёный', 'Синий'], labels: L(), created_at: now - 50 }),
  );

  try {
    const page = await w.start();
    await page.setViewportSize({ width: 1500, height: 950 });
    // Reach the submission the way Ivan did: from "Waiting for you".
    await page.getByTestId('waiting-row').filter({ hasText: 'Дизайн' }).first().click();
    const sub = page.getByTestId('ask-101');
    await expect(sub).toBeVisible({ timeout: 10_000 });
    await expect(sub).toHaveClass(/marked/);
    await shot(page, '01-submission-marked');
    const marked = await card(sub);

    // The mark fades after a moment; the block stays where it was.
    const box = await sub.boundingBox();
    await expect(sub).not.toHaveClass(/marked/, { timeout: 5_000 });
    await page.waitForTimeout(800);
    await shot(page, '02-submission-calm');
    const calm = await card(sub);
    expect(await sub.boundingBox()).toEqual(box);

    for (const [name, c] of [['marked', marked], ['calm', calm]] as const) {
      // One layer at most, never two frames, and room inside it.
      expect(c.frames, name).toBeLessThanOrEqual(1);
      expect(Math.min(...c.padding), name).toBeGreaterThanOrEqual(14);
      // The text stays on the feed's column; the header is inside the block.
      expect(c.bodyOnColumn, name).toBe(true);
      expect(c.metaInside, name).toBeGreaterThanOrEqual(14);
    }
    expect(marked.tinted).toBe(true);
    expect(calm.tinted).toBe(false);

    // The paid and the ordinary question are drawn the same way.
    for (const askId of [102, 103]) {
      const c = await card(page.getByTestId(`ask-${askId}`));
      expect(c.frames).toBe(0);
      expect(c.bodyOnColumn).toBe(true);
    }
    await page.getByTestId(`ask-103`).scrollIntoViewIfNeeded();
    await shot(page, '03-paid-and-question');

    // The Return form inside the block; then a narrow feed with the right panel open.
    await sub.scrollIntoViewIfNeeded();
    await sub.getByRole('button', { name: 'Return' }).click();
    await expect(sub.getByLabel('What should be fixed?')).toBeVisible();
    await shot(page, '04-return-form');
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByTestId('stages-button').click();
    await sub.scrollIntoViewIfNeeded();
    const narrow = await card(sub);
    expect(narrow.bodyOnColumn).toBe(true);
    const fits = await sub.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    await shot(page, '05-narrow-with-panel');
  } finally {
    await w.dispose();
  }
});
