import { expect, test } from '@playwright/test';
import { FakeDaemon } from '../test/fakeDaemon';
import { launchApp } from './launch';

test('window opens with the frame and a locked-down page', async () => {
  const d = new FakeDaemon();
  await d.start();
  const app = await launchApp({ HOPP_HOME: d.home });
  const page = await app.firstWindow();
  await expect(page.getByTestId('zone-left')).toBeVisible();
  await expect(page.getByTestId('zone-right')).toBeVisible();
  const exposed = await page.evaluate(() => ({
    require: typeof (globalThis as any).require,
    process: typeof (globalThis as any).process,
    hopp: typeof (window as any).hopp,
  }));
  expect(exposed).toEqual({ require: 'undefined', process: 'undefined', hopp: 'object' });
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    return (wc as any).getLastWebPreferences();
  });
  expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.sandbox).toBe(true);
  await app.close();
  await d.dispose();
});

test('with no daemon the window says so', async () => {
  const app = await launchApp();
  const page = await app.firstWindow();
  await expect(page.getByTestId('daemon-down')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start daemon' })).toBeVisible();
  await app.close();
});
