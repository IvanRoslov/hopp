// A running task gets one more worker profile from its details: the row
// shows it, its harness gets a start text, and the orchestrator is told.
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSession } from '../test/fakeDaemon';
import { World } from './world';

test('add a worker profile to a running task from its details', async () => {
  const w = new World();
  w.seedTask('lead', 'Port the docs');
  w.d.sessions = [makeSession('lead', { profile: 'sonnet' })];
  try {
    const page = await w.start();
    await page.getByTestId('task-row').filter({ hasText: 'Port the docs' }).click();
    await page.getByTestId('actions-menu').click();
    await page.getByRole('menuitem', { name: 'Task details' }).click();
    const details = page.getByTestId('task-details');
    await expect(details).toContainText('sonnet');

    await details.getByTestId('add-workers').click();
    await page.getByRole('menuitemcheckbox', { name: /deepseek-flash-1m/ }).click();
    await page.keyboard.press('Escape');
    await details.getByTestId('add-workers-confirm').click();

    await expect(details).toContainText('sonnet, deepseek-flash-1m', { timeout: 10_000 });
    const file = join(w.home, 'shell', 'tasks', 'lead', 'worker-deepseek.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('# Your role: worker');
    await expect.poll(() => w.d.messages.filter((m) => m.to === 'lead').length).toBe(1);
    expect(w.d.messages[0]!.body).toContain(`- \`deepseek-flash-1m\` (deepseek): \`--system-prompt-file ${file}\``);
    const state = JSON.parse(readFileSync(join(w.home, 'shell', 'state.json'), 'utf8'));
    expect(state.tasks[0]).toMatchObject({ workerProfiles: ['sonnet', 'deepseek-flash-1m'], addedWorkerProfiles: ['deepseek-flash-1m'] });
  } finally {
    await w.dispose();
  }
});
