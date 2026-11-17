// Picking a project's repository from GitHub, in the built app. The main
// process's GitHub calls are replaced for the test (no gh, no network): the
// status, the list, and a clone that takes a moment and lands in a throwaway
// repository under <HOPP_HOME>/repos. Set SHOTS_DIR to keep screenshots.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from './world';

const SHOTS = process.env['SHOTS_DIR'];

interface FakeGithub {
  status: { available: boolean; login: string; reason: string; command: string; home: string };
  repos: { fullName: string; description: string; private: boolean; defaultBranch: string; updatedAt: string; cloned: boolean }[];
  cloneMs: number;
}

async function fakeGithub(app: ElectronApplication, g: FakeGithub): Promise<void> {
  await app.evaluate(({ ipcMain }, g) => {
    const ok = <T>(value: T) => ({ ok: true, value });
    for (const m of ['githubStatus', 'listGithubRepos', 'addGithubRepo']) ipcMain.removeHandler('shell:' + m);
    ipcMain.handle('shell:githubStatus', () => g.status);
    ipcMain.handle('shell:listGithubRepos', (_e, q: string) => {
      const n = String(q ?? '').toLowerCase();
      return ok(g.repos.filter((r) => !n || r.fullName.toLowerCase().includes(n) || r.description.toLowerCase().includes(n)));
    });
    ipcMain.handle('shell:addGithubRepo', async (_e, name: string) => {
      await new Promise((r) => setTimeout(r, g.cloneMs));
      return ok({ path: `${g.status.home}/repos/${String(name).replace('/', '__')}` });
    });
  }, g);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => {
      if (t === 'light') document.documentElement.dataset['theme'] = 'light';
      else document.documentElement.dataset['theme'] = 'dark';
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
}

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

test('first project from a GitHub repository: pick, clone in place, create', async () => {
  const w = new World();
  // The clone the fake GitHub "makes": a real repository where it will land.
  mkdirSync(join(w.home, 'repos'));
  const site = join(w.home, 'repos', 'ivan__site');
  mkdirSync(site);
  w.git(site, 'init', '-q', '-b', 'main');
  w.git(site, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  const repos = [
    { fullName: 'ivan/site', description: 'The marketing site, with the blog and the docs', private: false, defaultBranch: 'main', updatedAt: ago(0.2), cloned: false },
    { fullName: 'ivan/api', description: 'Backend API', private: true, defaultBranch: 'develop', updatedAt: ago(3), cloned: true },
    { fullName: 'ivan/infra', description: 'Terraform for staging and production', private: true, defaultBranch: 'main', updatedAt: ago(12), cloned: false },
    { fullName: 'lessly/docs', description: '', private: false, defaultBranch: 'main', updatedAt: ago(60), cloned: false },
  ];
  try {
    const page = await w.start();
    await fakeGithub(w.app!, { status: { available: false, login: '', reason: 'The GitHub CLI (gh) is not logged in.', command: 'gh auth login', home: w.home }, repos, cloneMs: 1500 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await page.getByLabel('Name').fill('Site');
    await page.getByLabel('Description').fill('The marketing site and its blog.');
    await shot(page, '00-first-run');
    const slot = page.getByTestId('repo-slot');

    // gh not set up: why, and the command.
    await slot.getByRole('button', { name: 'Choose from GitHub' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a repository from GitHub' });
    await expect(dialog.getByTestId('gh-unavailable')).toContainText('not logged in');
    await expect(dialog.locator('code')).toHaveText('gh auth login');
    await shot(page, '01-gh-unavailable');

    // The human logs in; Check again finds it.
    await fakeGithub(w.app!, { status: { available: true, login: 'ivan', reason: '', command: '', home: w.home }, repos, cloneMs: 1500 });
    await dialog.getByRole('button', { name: 'Check again' }).click();
    await expect(dialog.getByTestId('gh-repo')).toHaveCount(4);
    await shot(page, '02-picker');
    await dialog.getByRole('combobox', { name: 'Search repositories' }).fill('site');
    await expect(dialog.getByTestId('gh-repo')).toHaveCount(1);
    await shot(page, '03-picker-search');
    await page.keyboard.press('Enter');

    // Cloning in place; Create waits.
    await expect(slot.getByTestId('repo-cloning')).toHaveText('Cloning ivan/site…');
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
    await shot(page, '04-cloning');
    await expect(slot.getByTestId('repo-label')).toHaveText('ivan/site');
    await expect(slot.getByTestId('repo-label')).toHaveAttribute('title', site);
    await shot(page, '05-picked');
    await page.getByRole('button', { name: 'Create' }).click();

    // The new task form says where the task starts.
    await expect(page.getByLabel('What needs to be done?')).toBeVisible();
    await expect(page.locator('.folder-hint')).toHaveText('A new worktree of ivan/site, starting from the latest origin/main.');
    await shot(page, '06-new-task');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-projects').getByTestId('repo-label')).toHaveText('ivan/site');
    await shot(page, '07-settings');
    const store = JSON.parse(readFileSync(join(w.home, 'shell', 'state.json'), 'utf8'));
    expect(store.projects[0].orchestratorRepo).toBe(site);
  } finally {
    await w.dispose();
  }
});
