// Markdown artifacts and feed texts in the built app: formatted by default,
// Source on demand, compare in both modes, a wide table scrolling inside
// its box, and a post written in markdown. MD_DOC names a document to show
// instead of the built-in one (for screenshots of a real one); SHOTS_DIR
// keeps screenshots in both themes.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Post } from '../src/shared/shell';
import { makeSession } from '../test/fakeDaemon';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

const BUILT_IN = `# Анализ: выбор версии Node.js

## Что просят

Клиент держит pnpm-монорепо на Node 26: \`.nvmrc = 26.13.1\`, **engineStrict** включён.

1. **toolkit** — поле версии в \`StaticSource.build\`:
   - проброс в \`StaticBuildSpec\`;
   - выбор образа по версии.
2. **app** — выбор версии в форме.

| Образ | Node | corepack | yarn |
|---|---|---|---|
| \`node:22-bookworm-slim\` | 22.23.5 | есть | 1.22.22 |
| \`node:26-bookworm-slim\` | 26.13.1 | **нет** | **нет** |

- [x] проверить образы
- [ ] описать дизайн

> Обход через \`--config.engine-strict=false\` собирает сайт не на той версии.

\`\`\`bash
corepack enable && pnpm install --frozen-lockfile
\`\`\`
`;

const WIDE = `| ${Array.from({ length: 14 }, (_, i) => `Колонка номер ${i + 1}`).join(' | ')} |\n|${'---|'.repeat(14)}\n| ${Array.from({ length: 14 }, (_, i) => `значение_${i + 1}_оченьдлинноеслово`).join(' | ')} |\n`;

test('markdown: viewer rendered and source, compare, wide table, feed', async () => {
  const w = new World();
  const id = 'node-version';
  w.seedTask(id, 'Выбор версии Node.js');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].pipeline = {
    id: 'p', name: 'Analysis', createdAt: 1, updatedAt: 1,
    stages: [{ id: 'analyse', name: 'Analyse the problem', does: 'Read the **brief** and the code;\n- list what changes\n- name the `files`', result: '', substages: false, approval: true }],
  };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession(id, { labels: { 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator' } })];

  const doc = process.env['MD_DOC'] ? readFileSync(process.env['MD_DOC'], 'utf8') : BUILT_IN;
  const L = (o: Record<string, string> = {}) => ({ 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator', 'hopp.stage': 'analyse', ...o });
  const now = Math.floor(Date.now() / 1000);
  const artifact = (name: string, version: number, text: string) => {
    const dir = join(w.home, 'artifacts', id, name, 'v' + version);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name + '.md');
    writeFileSync(path, text);
    w.d.artifacts.push({
      id: w.d.artifacts.length + 1, scope: id, name, version, filename: name + '.md', mime: 'text/markdown', size: Buffer.byteLength(text),
      sha256: '', from: id, labels: L(), created_at: now - 100 + version, path,
    });
  };
  artifact('analysis', 1, doc.replace(/\n## /, '\n_Черновик._\n\n## '));
  artifact('analysis', 2, doc);
  artifact('wide', 1, '# Широкая таблица\n\n' + WIDE);
  const post: Post = {
    id: 1, from: id, labels: L({ 'hopp.event': 'stage_started' }), attachments: [], created_at: now - 50,
    body: '## План\n\nНачинаю этап. Смотрю:\n- `apps/api/src/build/static-build.backend.ts`\n- **zod-схему** сервиса\n\nПодробности в [анализе](analysis@2).',
  };
  w.d.posts.push(post);

  try {
    const page = await w.start();
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.getByText('Выбор версии Node.js').first().click();
    await expect(page.getByTestId('pipeline-task-view')).toBeVisible();

    // The feed renders the post's markdown, compact.
    const body = page.locator('.entry-body.md-compact').filter({ has: page.locator('h2') });
    await expect(body.locator('h2')).toHaveText('План');
    await expect(body.locator('li code').first()).toHaveText('apps/api/src/build/static-build.backend.ts');
    await shot(page, '04-feed');

    // A link naming an artifact opens it in the viewer, formatted.
    await body.getByRole('button', { name: 'анализе' }).click();
    const viewer = page.getByTestId('artifact-viewer');
    await expect(viewer.getByTestId('viewer-markdown').locator('h1')).toBeVisible();
    await expect(viewer.getByTestId('viewer-markdown').locator('table').first()).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true');
    await shot(page, '01-viewer-rendered');
    await viewer.getByTestId('viewer-markdown').locator('table').first().scrollIntoViewIfNeeded();
    await shot(page, '01b-viewer-table');
    // The measure stays readable (about 80ch, never the whole panel).
    const measure = await viewer.locator('.md-doc').evaluate((e) => e.getBoundingClientRect().width / parseFloat(getComputedStyle(e).fontSize));
    expect(measure).toBeLessThanOrEqual(46);

    await viewer.getByRole('button', { name: 'Source' }).click();
    await expect(viewer.locator('pre.viewer-text')).toContainText('# ');
    await shot(page, '02-viewer-source');

    await viewer.getByRole('button', { name: 'Rendered' }).click();
    await viewer.getByRole('button', { name: 'Compare' }).click();
    await expect(viewer.getByTestId('viewer-markdown')).toHaveCount(2);
    await shot(page, '03-compare-rendered');

    // A wide table scrolls inside its own box; the viewer does not widen.
    await viewer.getByRole('button', { name: 'All artifacts' }).click();
    await page.getByTestId('artifact-tile-wide@1').click();
    const wideView = page.getByTestId('viewer-markdown');
    await expect(wideView.locator('table')).toBeVisible();
    const fit = await wideView.evaluate((e) => {
      const box = e.querySelector('.md-table') as HTMLElement;
      return { pane: e.scrollWidth <= e.clientWidth + 1, scrolls: box.scrollWidth > box.clientWidth };
    });
    expect(fit).toEqual({ pane: true, scrolls: true });
    await shot(page, '05-wide-table');

    // Stage texts in the Stages panel are formatted too.
    await page.getByTestId('stages-button').click();
    await page.getByText('Analyse the problem').first().click();
    await expect(page.locator('.stage-text strong').first()).toHaveText('brief');
  } finally {
    await w.dispose();
  }
});
