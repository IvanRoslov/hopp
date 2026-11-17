// Settings → Models: add a profile (a catalog model, a model id the catalog
// does not list) and copy one with another effort, through the real main
// process against a fake daemon in a temporary HOPP_HOME. SHOTS_DIR keeps
// screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProfile } from '../test/fakeDaemon';
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

test('add a model, add a custom one, copy one with another effort', async () => {
  const w = new World();
  w.seedTask('t1', 'Some task');
  w.d.profiles = [
    makeProfile('claude-opus-5-5', { agent: 'claude-code', model: 'claude-opus-5-5', description: 'Сложные задачи: архитектура, рефакторинг', position: 0 }),
    makeProfile('kimi-k3-1-pro', { agent: 'kimi-code', model: 'kimi-code/k3.1-pro', description: 'Воркеры по коду', position: 1 }),
  ];
  w.d.defaultProfile = 'claude-opus-5-5';
  w.d.catalogs = [
    { agent: 'claude-code', source: 'cache', warning: '', models: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5'].map((id) => ({ id, name: id, description: '', main: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })) },
    { agent: 'kimi-code', source: 'cache', warning: '', models: [
      { id: 'kimi-code/k3', name: 'K3', description: '', main: true, efforts: ['low', 'high', 'max'] },
      { id: 'kimi-code/k3.1-pro', name: 'K3.1 Pro', description: '', main: true, efforts: ['low', 'high', 'max'] },
    ] },
  ];
  try {
    const page = await w.start();
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Models' }).click();
    const row = (n: string) => page.locator(`[data-testid="model-row"][data-name="${n}"]`);
    await expect(row('kimi-k3-1-pro')).toBeVisible();
    const form = page.getByTestId('profile-form');

    // A catalog model at another effort.
    await page.getByTestId('add-model').click();
    await form.getByTestId('pf-harness').click();
    await page.getByRole('menuitemradio', { name: 'kimi-code' }).click();
    await form.getByLabel('Model').fill('kimi-code/k3');
    await form.getByTestId('pf-effort').click();
    await page.getByRole('menuitemradio', { name: 'max' }).click();
    await expect(form.getByLabel('Name')).toHaveValue('kimi-k3-max');
    await form.getByLabel('Description').fill('Быстрые правки, думает дольше');
    await shot(page, 'add-01-catalog-model');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(row('kimi-k3-max')).toHaveClass(/fresh/);
    expect(w.d.profiles.find((p) => p.name === 'kimi-k3-max')).toMatchObject({ agent: 'kimi-code', model: 'kimi-code/k3', effort: 'max', enabled: true });

    // A model id the catalog does not list.
    await page.getByTestId('add-model').click();
    await form.getByLabel('Model').fill('claude-opus-5-6-preview');
    await expect(form).toContainText('Not in the catalog: used as written');
    await form.getByTestId('pf-effort').click();
    await page.getByRole('menuitemradio', { name: 'xhigh' }).click();
    await expect(form.getByLabel('Name')).toHaveValue('claude-opus-5-6-preview-xhigh');
    await shot(page, 'add-02-custom-model');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(row('claude-opus-5-6-preview-xhigh')).toBeVisible();
    expect(w.d.profiles.find((p) => p.name === 'claude-opus-5-6-preview-xhigh')).toMatchObject({ model: 'claude-opus-5-6-preview', effort: 'xhigh' });

    // A taken name is refused next to Name.
    await page.getByTestId('add-model').click();
    await form.getByLabel('Model').fill('claude-sonnet-5-5');
    await form.getByLabel('Name').fill('kimi-k3-1-pro');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(form.locator('.field.has-error')).toContainText('kimi-k3-1-pro');
    await shot(page, 'add-03-name-taken');
    await form.getByRole('button', { name: 'Cancel' }).click();

    // Copy: same harness and model, another effort, one path.
    await row('kimi-k3-1-pro').getByTestId('model-menu-kimi-k3-1-pro').click();
    await page.getByRole('menuitem', { name: 'Copy…' }).click();
    await expect(form.getByTestId('pf-effort')).toBeFocused();
    await form.getByTestId('pf-effort').click();
    await page.getByRole('menuitemradio', { name: 'max' }).click();
    await expect(form.getByLabel('Name')).toHaveValue('kimi-k3-1-pro-max');
    await shot(page, 'add-04-copy');
    await form.getByRole('button', { name: 'Copy' }).click();
    await expect(row('kimi-k3-1-pro-max').getByTestId('effort-tag')).toHaveText('effort: max');
    expect(w.d.profiles.find((p) => p.name === 'kimi-k3-1-pro-max')).toMatchObject({ model: 'kimi-code/k3.1-pro', effort: 'max', description: 'Воркеры по коду' });
    await row('kimi-k3-1-pro-max').scrollIntoViewIfNeeded();
    await shot(page, 'add-05-copied');
  } finally {
    await w.dispose();
  }
});
