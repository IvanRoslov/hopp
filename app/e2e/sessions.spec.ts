import { expect, test } from '@playwright/test';
import { FakeDaemon, makeSession } from '../test/fakeDaemon';
import { launchApp } from './launch';

test('list follows the daemon; down and back; a session opens in the terminal', async () => {
  const d = new FakeDaemon();
  await d.start();
  d.sessions = [makeSession('lead', { activity: 'active' }), makeSession('helper', { parent: 'lead' })];
  d.defaultAttach = ['/bin/sh', '-c', 'echo hello from the fake attach; exec cat'];
  const app = await launchApp({ HOPP_HOME: d.home });
  try {
    const page = await app.firstWindow();
    const rows = page.getByTestId('session-row');
    await expect(rows).toHaveText(['leadworking', 'helperidle']);

    // An event updates a row.
    d.setSession(makeSession('helper', { parent: 'lead', activity: 'waiting_input' }));
    d.publish('session.activity_changed', 'helper');
    await expect(rows.nth(1)).toHaveText('helperwaiting for input');

    // Selecting a session opens its terminal.
    await rows.nth(0).click();
    await expect(page.locator('.xterm-rows')).toContainText('hello from the fake attach');
    await page.locator('.xterm-helper-textarea').pressSequentially('typed in the app');
    await expect(page.locator('.xterm-rows')).toContainText('typed in the app');

    // The daemon goes away: the state screen, with the socket path.
    await d.stop();
    await expect(page.getByTestId('daemon-down')).toBeVisible();
    await expect(page.getByTestId('daemon-down')).toContainText(d.socketPath);

    // It comes back with a new session: the list returns, reloaded.
    d.sessions.push(makeSession('newcomer'));
    await d.start();
    await expect(rows).toHaveText(['leadworking', 'helperwaiting for input', 'newcomeridle'], { timeout: 15_000 });
  } finally {
    await app.close().catch(() => {});
    await d.dispose();
  }
});
