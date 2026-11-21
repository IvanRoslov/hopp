// Settings → Models and the profile pickers show each profile's effort as a
// quiet tag: the level it sets, "effort: default" where its model has levels
// (per the catalog), nothing for a model without them. The main process's
// profile and catalog calls are replaced for the test. SHOTS_DIR keeps
// screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];
// BEFORE: screenshots of the old look only, without the checks.
const check = !process.env['BEFORE'];

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

const P = (name: string, agent: string, model: string, effort: string, position: number, description = '', isDefault = false) => ({
  name, agent, model, effort, description, enabled: true, position, isDefault,
});

test('effort is shown on every profile row and in the pickers', async () => {
  const w = new World();
  w.seedTask('t1', 'Some task');
  const profiles = [
    P('claude-opus-5-5', 'claude-code', 'claude-opus-5-5', '', 0, 'Сложные задачи: архитектура, рефакторинг', true),
    P('claude-opus-5-5-xhigh', 'claude-code', 'claude-opus-5-5', 'xhigh', 1, 'То же, но думает дольше'),
    P('kimi-k3-1-pro', 'kimi-code', 'kimi-k3-1-pro', '', 2, 'Воркеры по коду'),
    P('kimi-k3-1-pro-max', 'kimi-code', 'kimi-k3-1-pro', 'max', 3, 'Воркеры по коду, трудные места'),
    P('deepseek-flash-1m', 'deepseek', 'deepseek-chat', '', 4, 'Быстрая модель с длинным контекстом'),
  ];
  const catalog = [
    { agent: 'claude-code', source: 'harness', warning: '', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', description: '', main: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], known: true }] },
    { agent: 'kimi-code', source: 'harness', warning: '', models: [{ id: 'kimi-k3-1-pro', name: 'K3.1 Pro', description: '', main: true, efforts: ['low', 'high', 'max'], known: true }] },
    { agent: 'deepseek', source: 'built-in', warning: '', models: [{ id: 'deepseek-chat', name: 'DeepSeek', description: '', main: true, efforts: [], known: true }] },
  ];
  try {
    const page = await w.start();
    await w.app!.evaluate(({ ipcMain }, seed) => {
      const handle = (m: string, fn: (...a: never[]) => unknown) => {
        ipcMain.removeHandler('shell:' + m);
        ipcMain.handle('shell:' + m, (_e, ...a) => fn(...(a as never[])));
      };
      handle('listProfiles', () => seed.profiles);
      handle('modelCatalog', () => ({ ok: true, value: seed.catalog }));
    }, { profiles, catalog });
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Models' }).click();
    const row = (n: string) => page.locator(`[data-testid="model-row"][data-name="${n}"]`);
    if (check) await expect(row('kimi-k3-1-pro-max')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, '01-models-list');
    if (check) await expect(row('kimi-k3-1-pro-max').getByTestId('effort-tag')).toHaveText('effort: max');
    if (check) await expect(row('kimi-k3-1-pro').getByTestId('effort-tag')).toHaveText('effort: default');
    if (check) await expect(row('claude-opus-5-5-xhigh').getByTestId('effort-tag')).toHaveText('effort: xhigh');
    if (check) await expect(row('deepseek-flash-1m').getByTestId('effort-tag')).toHaveCount(0);

    // The New task pickers tell the two kimi profiles apart.
    await page.getByRole('button', { name: 'New task' }).first().click();
    await page.getByTestId('pick-orchestrator').click();
    await page.waitForTimeout(200);
    await shot(page, '02-new-task-picker');
    const opt = (n: string) => page.getByRole('menuitemradio', { name: new RegExp(`^${n}(?![\\w-])`) });
    if (check) await expect(opt('kimi-k3-1-pro-max').locator('.tag')).toHaveText('effort: max');
    if (check) await expect(opt('kimi-k3-1-pro').locator('.tag')).toHaveText('effort: default');
    if (check) await expect(opt('deepseek-flash-1m').locator('.tag')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The workers' list marks the chosen profiles with a checkbox on the left,
    // keeps descriptions out of the rows and clears the choice in one click.
    await page.getByTestId('pick-workers').click();
    const work = (n: string) => page.getByRole('menuitemcheckbox', { name: new RegExp(`^${n}(?![\\w-])`) });
    await work('kimi-k3-1-pro-max').click();
    await page.waitForTimeout(200);
    await shot(page, '02b-new-task-workers');
    if (check) await expect(work('kimi-k3-1-pro-max')).toHaveAttribute('aria-checked', 'true');
    if (check) await expect(work('kimi-k3-1-pro-max')).toHaveAttribute('title', 'Воркеры по коду, трудные места');
    if (check) await expect(work('kimi-k3-1-pro-max')).not.toContainText('Воркеры');
    if (check) await page.getByTestId('pick-workers-clear').click();
    if (check) await expect(page.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(0);
    if (check) await expect(page.getByTestId('pick-workers')).toContainText('none');
    await page.keyboard.press('Escape');

    // So does the New agent form.
    await page.getByRole('button', { name: 'New agent' }).click();
    await page.getByTestId('pick-agent-profile').click();
    await page.waitForTimeout(200);
    await shot(page, '03-new-agent-picker');
    if (check) await expect(opt('claude-opus-5-5-xhigh').locator('.tag')).toHaveText('effort: xhigh');
  } finally {
    await w.dispose();
  }
});
