// Settings → Models in the built app. The main process's profile calls are
// replaced for the test by an in-memory set of profiles that follows the
// contract (no daemon change, no harness catalogs). Set SHOTS_DIR to keep
// screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

const agents = ['claude-code', 'codex', 'kimi-code', 'pi', 'deepseek'];
const descriptions = [
  'Сложные задачи: архитектура, рефакторинг, трудные баги, оркестрация',
  'Понятные задачи по кодингу, основной выбор для воркеров если задача связана с кодом и не сильно сложная.',
  '',
  'Fast and affordable model for easier tasks.',
];

test('Settings → Models: switch, default, edit, import', async () => {
  const w = new World();
  w.seedTask('t1', 'Some task');
  const profiles = Array.from({ length: 20 }, (_, i) => ({
    name: i === 0 ? 'claude-opus-5-5' : `${agents[i % 5]}-model-${i}`,
    agent: agents[i % 5]!,
    model: `model-${i}`,
    effort: i % 7 === 3 ? 'xhigh' : '',
    description: descriptions[i % 4]!,
    enabled: i % 3 !== 2,
    position: i,
    isDefault: i === 0,
  }));
  const added = ['codex-gpt-6-2-luna', 'kimi-k3-2'].map((name, j) => ({
    name, agent: j ? 'kimi-code' : 'codex', model: name, effort: '', description: '', enabled: false, position: 20 + j, isDefault: false,
  }));
  try {
    const page = await w.start();
    await w.app!.evaluate(({ ipcMain, BrowserWindow }, seed) => {
      let list = seed.profiles;
      const ok = <T>(value: T) => ({ ok: true, value });
      const fail = (code: string, message: string) => ({ ok: false, error: { code, message } });
      const changed = () => BrowserWindow.getAllWindows().forEach((b) => b.webContents.send('shell:profiles-changed'));
      const find = (n: string) => list.find((p) => p.name === n);
      const handle = (m: string, fn: (...a: never[]) => unknown) => {
        ipcMain.removeHandler('shell:' + m);
        ipcMain.handle('shell:' + m, (_e, ...a) => fn(...(a as never[])));
      };
      handle('listProfiles', () => [...list].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.position - b.position));
      handle('setProfileEnabled', (n: string, on: boolean) => {
        const p = find(n)!;
        if (!on && p.isDefault) return fail('profile_is_default', `${n} is the default profile; make another one the default first.`);
        p.enabled = on;
        changed();
        return ok(p);
      });
      handle('updateProfile', (n: string, u: object) => {
        Object.assign(find(n)!, u);
        changed();
        return ok(find(n));
      });
      handle('setDefaultProfile', (n: string) => {
        for (const p of list) p.isDefault = p.name === n;
        changed();
        return ok(null);
      });
      handle('removeProfile', (n: string) => {
        list = list.filter((p) => p.name !== n);
        changed();
        return ok(null);
      });
      handle('moveProfile', () => ok(null));
      handle('modelCatalog', () => ok([]));
      handle('importModels', async () => {
        await new Promise((r) => setTimeout(r, 800));
        list = [...list, ...seed.added];
        changed();
        return ok({ added: seed.added, skipped: 9, failed: [{ agent: 'pi', reason: 'pi is not installed.' }] });
      });
    }, { profiles, added });
    await page.reload();

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Models' }).click();
    const on = page.getByRole('region', { name: 'Profiles on' });
    const off = page.getByRole('region', { name: 'Profiles off' });
    await expect(on.getByTestId('model-row')).toHaveCount(14);
    await expect(off.getByTestId('model-row')).toHaveCount(6);
    await shot(page, '01-models');

    // Scrolled: the tabs stay on top, nothing hides under the header.
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    const tabs = await page.getByRole('tablist').boundingBox();
    const top = await page.locator('.top').first().boundingBox();
    expect(tabs!.y).toBeGreaterThanOrEqual(top!.y + top!.height - 1);
    await shot(page, '02-scrolled');
    await page.mouse.wheel(0, -2000);

    const row = (n: string) => page.locator(`[data-testid="model-row"][data-name="${n}"]`);
    // The default refuses to be switched off; another is made default.
    await row('claude-opus-5-5').getByRole('switch').click();
    await expect(row('claude-opus-5-5').getByRole('alert')).toContainText('make another one the default first');
    await shot(page, '03-default-refused');
    await row('codex-model-1').getByTestId('model-menu-codex-model-1').click();
    await page.getByRole('menuitem', { name: 'Make default' }).click();
    await expect(row('codex-model-1').getByText('Default')).toBeVisible();

    // Edit a description in place.
    await row('kimi-code-model-7').getByTestId('model-menu-kimi-code-model-7').click();
    await page.getByRole('menuitem', { name: 'Edit…' }).click();
    await row('kimi-code-model-7').getByLabel('Description').fill('Воркеры по коду.\nНе для архитектуры.');
    await shot(page, '04-edit');
    await row('kimi-code-model-7').getByRole('button', { name: 'Save' }).click();
    await expect(row('kimi-code-model-7').locator('.mr-desc')).toHaveText('Воркеры по коду.\nНе для архитектуры.');

    // Switch one off: it moves to Off.
    await row('kimi-code-model-7').getByRole('switch').click();
    await expect(off.locator('[data-name="kimi-code-model-7"]')).toBeVisible();

    // Import.
    await page.getByTestId('import-models').click();
    await expect(page.getByTestId('import-models')).toHaveText(/Importing/);
    await shot(page, '05-importing');
    await expect(page.getByTestId('import-note')).toContainText('Added 2 models, switched off: turn on the ones you want.');
    await expect(page.getByTestId('import-note')).toContainText('pi is not installed.');
    await expect(row('kimi-k3-2')).toHaveClass(/fresh/);
    await row('kimi-k3-2').scrollIntoViewIfNeeded();
    await shot(page, '06-imported');

    // New task offers only what is on.
    await page.getByRole('button', { name: 'New task' }).first().click();
    await page.getByTestId('pick-orchestrator').click();
    await expect(page.getByRole('menuitemradio', { name: /kimi-code-model-7/ })).toHaveCount(0);
    await expect(page.getByRole('menuitemradio', { name: /codex-model-1(?!\d)/ })).toHaveCount(1);
  } finally {
    await w.dispose();
  }
});
