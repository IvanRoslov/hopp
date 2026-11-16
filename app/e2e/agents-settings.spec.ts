// A long-lived agent created, started and stopped; settings: a tool switched
// off, preferences saved, a lesson marked done.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLesson } from '../test/fakeDaemon';
import { World } from './world';

async function firstProject(page: Page) {
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
  await page.getByLabel('Name').fill('Docs');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByLabel('What needs to be done?')).toBeVisible();
}

test('a long-lived agent: create, start, stop', async () => {
  const w = new World();
  const folder = join(w.root, 'cto-home');
  mkdirSync(folder);
  try {
    const page = await w.start();
    await firstProject(page);
    await page.getByRole('button', { name: 'New agent' }).click();
    await page.getByLabel('Name').fill('cto');
    await page.getByLabel('Folder').fill(folder);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('agent-row').filter({ hasText: 'cto' })).toBeVisible();
    expect(w.d.mailboxes.map((b) => b.name)).toEqual(['cto']);

    // Off, with its mail count; Start launches it with id = name.
    w.d.mailboxes[0]!.unread = 2;
    w.d.publish('mailbox.received', 'cto', { mailbox: 'cto' });
    await page.getByTestId('agent-row').filter({ hasText: 'cto' }).click();
    await expect(page.getByText(/cto is off · 2 letters wait for it/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Start' }).first().click();
    await expect.poll(() => w.d.created.map((c) => c['id'])).toEqual(['cto']);
    expect(w.d.created[0]).toMatchObject({ dir: folder, labels: { 'hopp.agent': 'cto' } });
    expect(String(w.d.created[0]!['system_prompt'])).toContain('hopp inbox');
    w.d.publish('session.spawned', 'cto');
    await expect(page.locator('.xterm-rows')).toContainText('agent screen', { timeout: 15_000 });

    await page.getByTestId('actions-menu').click();
    await page.getByRole('menuitem', { name: 'Stop agent' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => w.d.sessions.find((s) => s.id === 'cto')?.state).toBe('killed');
  } finally {
    await w.dispose();
  }
});

test('settings: a tool switched off, preferences saved, a lesson done', async () => {
  const w = new World();
  const tool = join(w.home, 'tools', 'fetcher');
  mkdirSync(tool, { recursive: true });
  writeFileSync(join(tool, 'tool.yaml'), 'name: fetcher\ndescription: Fetch a web page as text\ncommand: [curl, -sL]\npaid: true\n');
  writeFileSync(join(tool, 'USAGE.md'), 'fetcher URL > page.html\n');
  w.d.lessons = [makeLesson(1, { body: 'The orchestrator needed a screenshot tool.' })];
  try {
    const page = await w.start();
    await firstProject(page);
    await page.getByRole('button', { name: 'Settings' }).click();

    await page.getByRole('tab', { name: 'Tools' }).click().catch(async () => page.getByRole('button', { name: 'Tools' }).click());
    const row = page.getByTestId('tool-fetcher');
    await expect(row).toContainText('Fetch a web page as text');
    await row.getByRole('switch').click();
    await expect.poll(() => readFileSync(join(tool, 'tool.yaml'), 'utf8')).toContain('enabled: false');
    await row.getByRole('button', { name: /fetcher/ }).click();
    await expect(page.getByText('fetcher URL > page.html')).toBeVisible();

    await page.locator('#tool-rules').fill('Video: use local tools.');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect.poll(() => readFileSync(join(w.home, 'tools', 'rules.md'), 'utf8')).toBe('Video: use local tools.\n');
    await expect(page.getByText(/^Saved /)).toBeVisible();

    await page.getByRole('tab', { name: 'Lessons' }).click().catch(async () => page.getByRole('button', { name: 'Lessons' }).click());
    await expect(page.getByText('The orchestrator needed a screenshot tool.')).toBeVisible();
    await page.getByRole('button', { name: 'Mark as done' }).click();
    await expect.poll(() => w.d.lessons[0]!.status).toBe('closed');
  } finally {
    await w.dispose();
  }
});
