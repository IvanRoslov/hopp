import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubRepo, Result } from '../../shared/shell';
import { fakeBridge, makeProject, makeTask, type ShellSeed } from '../../../test/bridge';
import { makeSession } from '../../../test/fakeDaemon';

vi.mock('../terminal/Terminal', () => ({
  Terminal: (p: { sessionId: string }) => <div data-testid="terminal">terminal:{p.sessionId}</div>,
}));

const { ShellApp } = await import('./ShellApp');
const { updatedAgo } = await import('./repos');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
// The search waits for a pause in typing.
const pause = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const HOME = '/Users/me/.hopp';
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const repo = (fullName: string, over: Partial<GithubRepo> = {}): GithubRepo => ({
  fullName, description: '', private: false, defaultBranch: 'main', updatedAt: ago(1), cloned: false, ...over,
});
const REPOS = [
  repo('ivan/site', { description: 'The marketing site', updatedAt: ago(0.1) }),
  repo('ivan/api', { description: 'Backend API', private: true, cloned: true, defaultBranch: 'develop', updatedAt: ago(3) }),
  repo('lessly/docs', { description: 'Docs', updatedAt: ago(40) }),
];
const available = { available: true, login: 'ivan', reason: '', command: '', home: HOME };

async function mount(f: ReturnType<typeof fakeBridge>) {
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

// The first-run form with Advanced open.
async function firstRun(github: NonNullable<ShellSeed['github']>) {
  const f = fakeBridge({ shell: { state: {}, github } });
  await mount(f);
  type(screen.getByLabelText('Name'), 'Shop');
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  return f;
}
const slot = () => screen.getByTestId('repo-slot');
const list = () => screen.getByTestId('repo-list');
const openPicker = async (field: HTMLElement) => {
  fireEvent.click(within(field).getByRole('button', { name: 'Choose from GitHub' }));
  await flush();
  await flush();
  return screen.getByRole('dialog', { name: 'Choose a repository from GitHub' });
};

describe('GitHub picker', () => {
  it('without gh says why and what to run, and checks again', async () => {
    const f = await firstRun({ status: { available: false, reason: 'gh is not logged in.', command: 'gh auth login', home: HOME } });
    const d = await openPicker(slot());
    expect(within(d).getByTestId('gh-unavailable').textContent).toContain('gh is not logged in.');
    expect(within(d).getByText('gh auth login').tagName).toBe('CODE');
    expect(f.shell!.listGithubRepos).not.toHaveBeenCalled();
    const calls = f.shell!.githubStatus.mock.calls.length;
    fireEvent.click(within(d).getByRole('button', { name: 'Check again' }));
    await flush();
    expect(f.shell!.githubStatus.mock.calls.length).toBe(calls + 1);
  });

  it('lists repositories with their marks, searches, and is driven by the keyboard', async () => {
    const f = await firstRun({ status: available, repos: REPOS });
    const d = await openPicker(slot());
    const rows = within(d).getAllByTestId('gh-repo');
    expect(rows.map((r) => r.querySelector('.gh-repo-name')!.textContent)).toEqual(['ivan/site', 'ivan/api', 'lessly/docs']);
    expect(rows[1]!.textContent).toContain('Private');
    expect(rows[1]!.textContent).toContain('Cloned');
    expect(rows[0]!.textContent).not.toContain('Private');
    expect(rows[1]!.textContent).toContain('Backend API');
    expect(rows[1]!.textContent).toContain('updated 3 days ago');
    expect(d.textContent).toContain('as ivan');
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');

    const search = within(d).getByRole('combobox', { name: 'Search repositories' });
    type(search, 'backend');
    await pause();
    expect(within(d).getAllByTestId('gh-repo').map((r) => r.querySelector('.gh-repo-name')!.textContent)).toEqual(['ivan/api']);
    type(search, 'nothing-like-it');
    await pause();
    expect(d.textContent).toContain('No repositories match “nothing-like-it”.');
    type(search, '');
    await pause();

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(within(d).getAllByTestId('gh-repo')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(search, { key: 'Enter' });
    await flush();
    expect(f.shell!.addGithubRepo).toHaveBeenCalledWith('ivan/api');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the loading state, and an error with Try again', async () => {
    let answer: (r: Result<GithubRepo[]>) => void = () => {};
    const f = await firstRun({ status: available, repos: REPOS });
    f.shell!.listGithubRepos.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    const d = await openPicker(slot());
    expect(d.textContent).toContain('Loading your repositories…');
    await act(async () => answer({ ok: false, error: { code: 'gh_failed', message: 'network is down' } }));
    expect(within(d).getByRole('alert').textContent).toContain('Could not list repositories: network is down');
    fireEvent.click(within(d).getByRole('button', { name: 'Try again' }));
    await flush();
    await flush();
    expect(within(d).getAllByTestId('gh-repo')).toHaveLength(3);
  });

  it('clones in place: the field says so and Create waits; then the field holds owner/repo', async () => {
    let finish: (r: Result<{ path: string }>) => void = () => {};
    const f = await firstRun({ status: available, repos: REPOS, add: () => new Promise((res) => (finish = res)) });
    const d = await openPicker(slot());
    fireEvent.click(within(d).getAllByTestId('gh-repo')[0]!);
    await flush();
    expect(within(slot()).getByTestId('repo-cloning').textContent).toBe('Cloning ivan/site…');
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText('Waiting for ivan/site to clone…')).toBeTruthy();
    // The rest of the form stays usable meanwhile.
    type(screen.getByLabelText('Guardrails'), 'No paid actions.');
    await act(async () => finish({ ok: true, value: { path: `${HOME}/repos/ivan__site` } }));
    const label = within(slot()).getByTestId('repo-label');
    expect(label.textContent).toBe('ivan/site');
    expect(label.getAttribute('title')).toBe(`${HOME}/repos/ivan__site`);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ orchestratorRepo: `${HOME}/repos/ivan__site`, guardrails: 'No paid actions.' }),
    );
  });

  it('a failed clone is an error next to the field, which stays empty', async () => {
    await firstRun({ status: available, repos: REPOS, add: async () => ({ ok: false, error: { code: 'clone_failed', message: 'permission denied' } }) });
    const d = await openPicker(slot());
    fireEvent.click(within(d).getAllByTestId('gh-repo')[0]!);
    await flush();
    expect(within(slot()).getByRole('alert').textContent).toBe('Could not clone ivan/site: permission denied');
    expect((screen.getByLabelText('Worktree for the orchestrator') as HTMLInputElement).value).toBe('');
  });

  it('workers: repositories from GitHub and folders are rows; a typed path is kept on save', async () => {
    const f = await firstRun({ status: available, repos: REPOS });
    let d = await openPicker(list());
    fireEvent.click(within(d).getAllByTestId('gh-repo')[2]!);
    await flush();
    d = await openPicker(list());
    // A repository already in the list is not offered again.
    expect(within(d).getAllByTestId('gh-repo').map((r) => r.querySelector('.gh-repo-name')!.textContent)).toEqual(['ivan/site', 'ivan/api']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    const input = screen.getByLabelText('Worktrees for workers');
    type(input, '/repos/ui');
    fireEvent.keyDown(input, { key: 'Enter' });
    type(input, '/repos/typed');
    expect(within(list()).getAllByTestId('repo-label').map((l) => l.textContent)).toEqual(['lessly/docs', '/repos/ui']);
    fireEvent.click(within(list()).getByRole('button', { name: 'Remove /repos/ui' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ workerRepos: [`${HOME}/repos/lessly__docs`, '/repos/typed'] }),
    );
  });
});

describe('repository labels', () => {
  const managed = `${HOME}/repos/ivan__api`;
  const seed = () =>
    fakeBridge({
      sessions: [makeSession('t1')],
      shell: {
        state: {
          projects: [makeProject('shop', { name: 'Shop', orchestratorRepo: managed }), makeProject('blog', { name: 'Blog', orchestratorRepo: '/Users/me/blog' })],
          tasks: [makeTask('t1', 'shop', { title: 'Fix it', sessionId: 't1' })],
        },
        github: { status: available, repos: REPOS },
      },
    });

  it('settings name a managed clone owner/repo with the GitHub mark, a folder by its path', async () => {
    await mount(seed());
    fireEvent.click(screen.getByText('Settings'));
    await flush();
    const labels = within(screen.getByTestId('settings-projects')).getAllByTestId('repo-label');
    expect(labels.map((l) => [l.textContent, l.getAttribute('title')])).toEqual([
      ['ivan/api', managed],
      ['/Users/me/blog', '/Users/me/blog'],
    ]);
  });

  it('the project form shows the clone as a row; task details name the repository', async () => {
    await mount(seed());
    fireEvent.click(screen.getByText('Settings'));
    await flush();
    fireEvent.click(within(screen.getByTestId('settings-projects')).getByText('Shop'));
    await flush();
    expect(within(slot()).getByTestId('repo-label').textContent).toBe('ivan/api');
    fireEvent.click(within(slot()).getByRole('button', { name: `Remove ${managed}` }));
    expect((screen.getByLabelText('Worktree for the orchestrator') as HTMLInputElement).value).toBe('');
  });

  it('task details show the repository', async () => {
    await mount(seed());
    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task details' }));
    await flush();
    expect(within(screen.getByTestId('task-details')).getByTestId('repo-label').textContent).toBe('ivan/api');
  });

  it('New task says a managed clone starts from the latest origin/<default branch>', async () => {
    await mount(seed());
    await flush();
    const hint = () => document.querySelector('.folder-hint')!.textContent;
    expect(hint()).toBe('A new worktree of ivan/api, starting from the latest origin/develop.');
    fireEvent.click(screen.getByTestId('pick-project'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Blog' }));
    expect(hint()).toBe('A new worktree of /Users/me/blog at its current commit; uncommitted changes are not included.');
  });

  it('says how long ago a repository was updated', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(updatedAgo('2026-11-14T12:00:00Z', now)).toBe('updated 3 days ago');
    expect(updatedAgo('2026-11-17T11:59:40Z', now)).toBe('updated just now');
    expect(updatedAgo('nonsense', now)).toBe('');
  });
});
