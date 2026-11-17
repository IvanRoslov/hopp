// An agent name that a live tmux session outside hopp holds (the fake daemon
// plays that tmux session; no real one is touched): New agent refuses it next
// to Name, Start says it in words with Rename and Remove beside it, a rename
// keeps the letters under the old name, and Remove agent in the menu takes
// the empty mailbox with it. Set SHOTS_DIR to keep screenshots.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];
const TMUX = 'A tmux session named cto already runs outside hopp. Choose another name, or close that session.';

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset['theme'] = t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

test('an agent name taken by tmux outside hopp: refused, renamed, removed', async () => {
  const w = new World();
  const folder = join(w.root, 'cto-home');
  mkdirSync(folder);
  try {
    const page = await w.start();
    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await page.getByLabel('Name').fill('Docs');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByLabel('What needs to be done?')).toBeVisible();

    // New agent: refused next to Name, nothing stored.
    w.d.foreignTmux = ['cto'];
    await page.getByRole('button', { name: 'New agent' }).click();
    await page.getByLabel('Name').fill('cto');
    await page.getByLabel('Folder').fill(folder);
    await page.getByRole('button', { name: 'Create' }).click();
    const nameField = page.getByLabel('Name').locator('xpath=ancestor::*[contains(@class,"field")][1]');
    await expect(nameField.getByRole('alert')).toHaveText(TMUX);
    expect(w.d.mailboxes).toEqual([]);
    await shot(page, '01-create-refused');

    // An agent stored before the tmux session appeared: Start explains.
    w.d.foreignTmux = [];
    await page.getByRole('button', { name: 'Create' }).click();
    const row = page.getByTestId('agent-row').filter({ hasText: 'cto' });
    await expect(row).toBeVisible();
    w.d.foreignTmux = ['cto'];
    w.d.mailboxes[0]!.unread = 2;
    w.d.mailboxes[0]!.total = 2;
    w.d.publish('mailbox.received', 'cto', { mailbox: 'cto' });
    await row.click();
    await expect(page.getByTestId('work-status')).toHaveText('Off · 2 letters wait for it', { timeout: 10_000 });
    await page.getByTestId('agent-start').click();
    const alert = page.locator('.top-alert').getByRole('alert');
    await expect(alert).toContainText(TMUX);
    await expect(alert).not.toContainText('session id is taken');
    await shot(page, '02-start-refused');

    // Rename: the letters stay under the old name, said before renaming.
    await alert.getByRole('button', { name: 'Rename' }).click();
    const form = page.getByTestId('rename-agent');
    await form.getByLabel('New name').fill('boss');
    await form.getByRole('button', { name: 'Rename' }).click();
    await expect(form.getByRole('status')).toHaveText(
      '2 letters stay under the old name cto: hopp cannot move mail, and nothing is deleted. boss starts with an empty mailbox.',
    );
    await shot(page, '03-rename-confirm');
    await form.getByRole('button', { name: 'Rename anyway' }).click();
    await expect(page.getByTestId('agent-details')).toContainText('boss');
    await expect(page.getByTestId('agent-row').filter({ hasText: 'boss' })).toBeVisible();
    expect(w.d.mailboxes.map((b) => b.name).sort()).toEqual(['boss', 'cto']);
    await shot(page, '04-renamed');

    // Remove agent in the menu asks, then removes; the empty mailbox goes.
    await page.getByTestId('actions-menu').click();
    await page.getByRole('menuitem', { name: 'Remove agent' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Remove boss? Its folder stays as it is.');
    await shot(page, '05-remove-confirm');
    await ask.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByTestId('agent-row')).toHaveCount(0);
    await expect.poll(() => w.d.mailboxes.map((b) => b.name)).toEqual(['cto']);
    // The refused Start launched nothing.
    expect(w.d.sessions).toEqual([]);
  } finally {
    await w.dispose();
  }
});
