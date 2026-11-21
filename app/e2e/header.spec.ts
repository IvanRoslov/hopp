// The work view's header: one row (title, Start or Stop, Questions, the
// session picker, a quiet status, the menu) and the terminal right under it.
// Set SHOTS_DIR to keep screenshots at 1100, 1500 and 2000 px in both themes.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../src/shared/shell';
import { makeSession } from '../test/fakeDaemon';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];
const WIDTHS = [1100, 1500, 2000];

async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(SHOTS, `${name}-${width}-${theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

function seed(w: World) {
  const now = Math.floor(Date.now() / 1000);
  const task = (id: string, title: string, over: Partial<Task> = {}): Task => {
    const dir = join(w.root, id);
    mkdirSync(dir, { recursive: true });
    return {
      id, projectSlug: 'site', title, brief: title, sessionId: id, dir, branch: null, orchestratorProfile: 'sonnet',
      workerProfiles: ['sonnet'], addedWorkerProfiles: [], pipeline: null, base: null, startedBy: null, status: 'active', hidden: false, createdAt: now - 3600, finishedAt: 0, ...over,
    };
  };
  const agentDir = join(w.root, 'cto-home');
  mkdirSync(agentDir);
  mkdirSync(join(w.home, 'shell'), { recursive: true });
  writeFileSync(join(w.home, 'shell', 'state.json'), JSON.stringify({
    version: 1, seeded: ['starter-pipelines'],
    projects: [{ slug: 'site', name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 1 }],
    pipelines: [],
    tasks: [
      task('shop-fix', 'Fix the checkout total when a coupon and a gift card are both applied to one order'),
      task('promo', 'Promo video', {
        pipeline: { id: 'p', name: 'Video', createdAt: 1, updatedAt: 1, stages: [{ id: 's', name: 'Script', does: '', result: '', substages: false, approval: true }] },
      }),
    ],
    agents: [{ name: 'lepsto-cto', profile: 'sonnet', dir: agentDir, createdAt: 1 }],
  }));
  w.d.sessions = [
    makeSession('shop-fix', { activity: 'active', labels: { 'hopp.task': 'shop-fix' } }),
    makeSession('shop-fix-tests', { parent: 'shop-fix', activity: 'idle' }),
    makeSession('promo', { activity: 'idle', labels: { 'hopp.task': 'promo' } }),
  ];
  w.d.mailboxes = [{ name: 'lepsto-cto', unread: 2, total: 2 }];
}

test('the header is one row and the terminal starts right under it', async () => {
  const w = new World();
  seed(w);
  try {
    const page = await w.start();
    // An agent that is off.
    await page.getByTestId('agent-row').filter({ hasText: 'lepsto-cto' }).click();
    await expect(page.getByTestId('work-view')).toContainText('2 letters wait for it', { timeout: 10_000 });
    await shots(page, '01-agent-off');

    // A running task with a worker: the picker sits in the header.
    await page.getByTestId('task-row').filter({ hasText: 'Fix the checkout' }).click();
    await expect(page.locator('.xterm-rows')).toContainText('agent screen', { timeout: 15_000 });
    // One header row of 52 px; the terminal box starts 8 px under it.
    const top = (await page.locator('.task-top').boundingBox())!;
    const box = (await page.locator('.term-box').boundingBox())!;
    expect(top.height).toBeCloseTo(52, 0);
    expect(box.y - (top.y + top.height)).toBeCloseTo(8, 0);
    await expect(page.locator('.task-top').getByTestId('session-picker')).toBeVisible();
    await shots(page, '02-task-running');

    await page.getByTestId('questions-button').click();
    await page.waitForTimeout(300);
    await shots(page, '03-task-questions-open');
    await page.getByTestId('questions-button').click();

    await page.getByTestId('task-row').filter({ hasText: 'Promo video' }).click();
    await expect(page.getByTestId('pipeline-task-view')).toBeVisible();
    await shots(page, '04-pipeline-task');
  } finally {
    await w.dispose();
  }
});
