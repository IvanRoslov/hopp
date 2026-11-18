// Attachments: files and folders added to a new task and to a line in a
// task's feed, by the clip (the system dialog) and by paste. They go out as
// the Attached block of absolute paths; in the feed that block shows as
// chips that open the file. Set SHOTS_DIR to keep screenshots.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSession } from '../test/fakeDaemon';
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

// The system dialog answers with these paths, and opening a path records it
// instead of opening an app.
async function fakeDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog, shell }, p) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog;
    shell.openPath = async (path: string) => {
      g.opened.push(path);
      return '';
    };
  }, paths);
}

// A paste of a screenshot: the main process answers as it does for an image
// on the clipboard, with the file it saved.
async function fakePaste(app: ElectronApplication, path: string) {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('shell:pasteAttachments');
    ipcMain.handle('shell:pasteAttachments', () => ({ kind: 'image', items: [{ path: p, dir: false }] }));
  }, path);
}

test('a new task starts with attached files and folders', async () => {
  const w = new World();
  const repo = w.repo('site');
  const files = join(w.root, 'files');
  mkdirSync(join(files, 'designs'), { recursive: true });
  writeFileSync(join(files, 'spec.md'), '# Spec\n');
  writeFileSync(join(files, 'shot.png'), 'png');
  try {
    const page = await w.start();
    await page.getByLabel('Name').fill('Site');
    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Worktree for the orchestrator').fill(repo);
    await page.getByRole('button', { name: 'Create' }).click();

    const brief = page.getByLabel('What needs to be done?');
    await expect(brief).toBeVisible();
    await brief.fill('Build the page from the spec');
    await fakeDialog(w.app!, [join(files, 'spec.md'), join(files, 'designs')]);
    await page.getByRole('button', { name: 'Attach files or folders' }).click();
    const chips = page.getByTestId('attachments').locator('.att-chip');
    await expect(chips).toHaveText(['spec.md', 'designs']);
    await expect(chips.nth(1)).toHaveAttribute('data-dir', 'true');
    // The same path again is not added twice.
    await page.getByRole('button', { name: 'Attach files or folders' }).click();
    await expect(chips).toHaveCount(2);
    // A pasted screenshot comes in as its saved file.
    await fakePaste(w.app!, join(files, 'shot.png'));
    // A synthetic paste with no text: Cmd+V would read the real clipboard.
    await brief.focus();
    await brief.evaluate((el) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })));
    await expect(chips).toHaveText(['spec.md', 'designs', 'shot.png']);
    await shot(page, '01-new-task');

    await page.getByRole('button', { name: 'Start the task' }).click();
    await expect(page.getByTestId('work-view')).toBeVisible();
    const created = w.d.created.at(-1)!;
    const block = `Build the page from the spec\n\nAttached:\n- ${join(files, 'spec.md')}\n- ${join(files, 'designs')}/\n- ${join(files, 'shot.png')}`;
    expect(JSON.stringify(created)).toContain(JSON.stringify(block).slice(1, -1));
  } finally {
    await w.dispose();
  }
});

test('a line in the feed carries attachments, shown as chips that open the file', async () => {
  const w = new World();
  const id = 'landing';
  w.seedTask(id, 'Landing');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].pipeline = {
    id: 'p', name: 'Site', createdAt: 1, updatedAt: 1,
    stages: [{ id: 'design', name: 'Design', does: '', result: '', substages: false, approval: true }],
  };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession(id, { labels: { 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator' } })];
  const files = join(w.root, 'files');
  mkdirSync(join(files, 'assets'), { recursive: true });
  writeFileSync(join(files, 'notes.txt'), 'notes');
  try {
    const page = await w.start();
    await page.getByTestId('task-row').filter({ hasText: 'Landing' }).click();
    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
    await fakeDialog(w.app!, [join(files, 'notes.txt'), join(files, 'assets')]);
    await composer.getByRole('button', { name: 'Attach files or folders' }).click();
    await expect(composer.locator('.att-chip')).toHaveText(['notes.txt', 'assets']);
    await composer.getByRole('button', { name: 'Remove assets' }).click();
    await expect(composer.locator('.att-chip')).toHaveText(['notes.txt']);
    await page.getByLabel('Write to the orchestrator').fill('Use these notes');
    await shot(page, '02-feed-composer');
    await composer.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => w.d.messages.at(-1)?.body).toBe(`Use these notes\n\nAttached:\n- ${join(files, 'notes.txt')}`);
    await expect(composer.locator('.att-chip')).toHaveCount(0);
    // The human's line: text, then its paths as chips.
    const sent = page.getByTestId('attached').last();
    await expect(sent.locator('.att-chip')).toHaveText(['notes.txt'], { timeout: 10_000 });
    await expect(page.getByText('Attached:')).toHaveCount(0);
    await shot(page, '03-feed-sent');
    await sent.getByRole('button', { name: /notes\.txt/ }).click();
    await expect.poll(() => w.app!.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([join(files, 'notes.txt')]);

    // A file gone before sending stops the line and says so.
    await fakeDialog(w.app!, [join(files, 'notes.txt')]);
    await composer.getByRole('button', { name: 'Attach files or folders' }).click();
    await expect(composer.locator('.att-chip')).toHaveCount(1);
    const before = w.d.messages.length;
    (await import('node:fs')).rmSync(join(files, 'notes.txt'));
    await composer.getByRole('button', { name: 'Send' }).click();
    await expect(composer.getByRole('alert')).toContainText('notes.txt is not there any more');
    expect(w.d.messages.length).toBe(before);
  } finally {
    await w.dispose();
  }
});
