// The morning path: first run → a project with a repository → a task without
// a pipeline → its terminal and questions → stop, resume, finish.
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeAsk, makeSession } from '../test/fakeDaemon';
import { World } from './world';

test('first run to a finished task', async () => {
  const w = new World();
  const repo = w.repo('site');
  try {
    const page = await w.start();

    // First run: only the project form.
    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await page.getByLabel('Name').fill('Site');
    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Worktree for the orchestrator').fill(repo);
    await page.getByLabel('Guardrails').fill('Never push to main.');
    await page.getByRole('button', { name: 'Create' }).click();

    // New task.
    const brief = page.getByLabel('What needs to be done?');
    await expect(brief).toBeVisible();
    await brief.fill('Fix the header\nIt overlaps the logo.');
    await page.getByRole('button', { name: 'Start the task' }).click();

    // The task view: its worktree, its session and terminal.
    await expect(page.getByTestId('work-view')).toBeVisible();
    await expect(page.locator('.xterm-rows')).toContainText('agent screen', { timeout: 15_000 });
    const created = w.d.created.at(-1)!;
    expect(created).toMatchObject({ id: 'fix-the-header', labels: { 'hopp.project': 'site', 'hopp.role': 'orchestrator' } });
    expect(String(created['system_prompt'])).toContain('Never push to main.');
    expect(existsSync(join(w.home, 'worktrees', 'site', 'fix-the-header', 'README.md'))).toBe(true);
    expect(w.git(repo, 'branch', '--list', 'hopp/fix-the-header').trim()).toContain('hopp/fix-the-header');

    // A worker appears in the session picker.
    w.d.sessions.push(makeSession('fix-the-header-w1', { parent: 'fix-the-header', labels: { 'hopp.task': 'fix-the-header', 'hopp.role': 'worker' } }));
    w.d.publish('session.spawned', 'fix-the-header-w1');

    // A question from the orchestrator, answered from the questions column.
    w.d.asks.push(makeAsk(1, 'fix-the-header', { body: 'Keep the old logo?', options: ['Keep', 'Replace'], labels: { 'hopp.task': 'fix-the-header' } }));
    w.d.publish('ask.created', 'fix-the-header', { id: 1 });
    await expect(page.getByTestId('questions-button')).toHaveText('Questions · 1', { timeout: 10_000 });
    await page.getByTestId('questions-button').click();
    await page.getByTestId('questions-panel').getByRole('button', { name: 'Keep' }).click();
    await expect.poll(() => w.d.asks[0]!.status).toBe('answered');
    expect(w.d.asks[0]!.choice).toBe('Keep');
    await page.getByLabel('Close the column').click();

    // A second question, answered from "Waiting for you".
    w.d.asks.push(makeAsk(2, 'fix-the-header', { body: 'Which font for the header?', options: [], labels: { 'hopp.task': 'fix-the-header' } }));
    w.d.publish('ask.created', 'fix-the-header', { id: 2 });
    const row = page.getByTestId('waiting-row').filter({ hasText: 'Which font for the header?' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    const answer = page.getByTestId('questions-panel').getByLabel('Your answer');
    await answer.fill('The system font');
    await answer.press('Enter');
    await expect.poll(() => w.d.asks[1]!.status).toBe('answered');
    expect(w.d.asks[1]!.answer).toBe('The system font');

    // Stop, with a confirmation that names the task and its child sessions.
    await page.getByTestId('actions-menu').click();
    await page.getByRole('menuitem', { name: 'Stop task' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Stop Fix the header and its child sessions (1)?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click();
    await expect.poll(() => w.d.sessions.map((s) => s.state)).toEqual(['killed', 'killed']);
    w.d.publish('session.state_changed', 'fix-the-header', { to: 'killed' });

    // Resume.
    await page.getByRole('button', { name: 'Resume' }).first().click();
    await expect.poll(() => w.d.sessions[0]!.state).toBe('running');
    w.d.publish('session.restored', 'fix-the-header');

    // Finish: the task moves to Recent and keeps its worktree.
    await page.getByTestId('actions-menu').click();
    await page.getByRole('menuitem', { name: 'Finish task' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByTestId('recent-row').filter({ hasText: 'Fix the header' })).toBeVisible({ timeout: 10_000 });
    expect(w.d.sessions[0]!.state).toBe('done');
    expect(existsSync(join(w.home, 'worktrees', 'site', 'fix-the-header'))).toBe(true);
  } finally {
    await w.dispose();
  }
});
