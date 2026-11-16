// A running task follows the daemon: its terminal opens; the daemon goes
// down (the notice names the socket, the terminal stays) and comes back (the
// task and its sessions reload).
import { expect, test } from '@playwright/test';
import { makeSession } from '../test/fakeDaemon';
import { World } from './world';

test('a task follows the daemon down and back; its terminal stays', async () => {
  const w = new World();
  w.seedTask('lead', 'Port the docs');
  w.d.sessions = [makeSession('lead', { activity: 'active' }), makeSession('helper', { parent: 'lead' })];
  w.d.defaultAttach = ['/bin/sh', '-c', 'echo hello from the fake attach; exec cat'];
  try {
    const page = await w.start();
    const row = page.getByTestId('task-row').filter({ hasText: 'Port the docs' });
    await expect(row).toBeVisible();
    await row.click();

    const screen = page.locator('.xterm-rows');
    await expect(screen).toContainText('hello from the fake attach', { timeout: 15_000 });
    await page.locator('.xterm-helper-textarea').pressSequentially('typed in the app');
    await expect(screen).toContainText('typed in the app');
    await page.getByTestId('session-picker').click();
    await expect(page.getByRole('menuitemradio', { name: /helper/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // The daemon goes away: the notice with the socket path; the terminal stays.
    await w.d.stop();
    await expect(page.getByTestId('daemon-down')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('daemon-down')).toContainText(w.d.socketPath);
    await expect(screen).toContainText('typed in the app');

    // It comes back with a new worker: the task's sessions reload.
    w.d.sessions.push(makeSession('newcomer', { parent: 'lead' }));
    await w.d.start();
    await expect(page.getByTestId('daemon-down')).toHaveCount(0, { timeout: 15_000 });
    await page.getByTestId('session-picker').click();
    await expect(page.getByRole('menuitemradio', { name: /newcomer/ })).toBeVisible({ timeout: 10_000 });
  } finally {
    await w.dispose();
  }
});
