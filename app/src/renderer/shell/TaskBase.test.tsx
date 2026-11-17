import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskBase } from '../../shared/shell';
import { fakeBridge, makeProject, makeTask } from '../../../test/bridge';
import { makeSession } from '../../../test/fakeDaemon';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');
const { baseLine } = await import('./TaskBase');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const HOME = '/Users/me/.hopp';
const now = Math.floor(Date.now() / 1000);
const clone: TaskBase = { ref: 'origin/main', commit: '9d10cd1f0e2a3b4c', committedAt: now - 300, fetched: true, warning: '' };
const stale: TaskBase = {
  ref: 'origin/main', commit: '4b2e7aa91c', committedAt: Date.UTC(2026, 10, 14, 9, 30) / 1000, fetched: false,
  warning: 'git fetch: Could not resolve host: github.com',
};

async function open(base: TaskBase | null, over: Partial<Task> = {}) {
  const f = fakeBridge({
    sessions: [makeSession('t1')],
    shell: {
      state: {
        projects: [makeProject('shop', { name: 'Shop', orchestratorRepo: `${HOME}/repos/ivan__shop` })],
        tasks: [makeTask('t1', 'shop', { title: 'Fix it', sessionId: 't1', base, ...over })],
      },
      github: { status: { available: true, login: 'ivan', home: HOME } },
    },
  });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getByTestId('task-row'));
  await flush();
  return f;
}
const details = () => {
  fireEvent.click(screen.getByTestId('actions-menu'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Task details' }));
  return screen.getByTestId('task-details');
};

describe('what a task started from', () => {
  it('reads ref · short commit · age', () => {
    const t = Date.UTC(2026, 10, 17, 12) / 1000;
    expect(baseLine({ ...clone, committedAt: t - 300 }, t * 1000)).toBe('origin/main · 9d10cd1 · 5 minutes ago');
    expect(baseLine({ ref: 'HEAD (main)', commit: 'abc1234def', committedAt: t - 3 * 86400, fetched: false, warning: '' }, t * 1000)).toBe(
      'HEAD (main) · abc1234 · 3 days ago',
    );
  });

  it('task details have a "Started from" row with the full commit in its tooltip', async () => {
    await open(clone);
    const row = within(details()).getByTestId('task-base');
    expect(row.textContent).toBe('origin/main · 9d10cd1 · 5 minutes ago');
    expect(row.getAttribute('title')).toBe('9d10cd1f0e2a3b4c');
    expect(screen.queryByTestId('base-warning')).toBeNull();
  });

  it('a task stored before this was recorded shows nothing', async () => {
    await open(null);
    expect(within(details()).queryByTestId('task-base')).toBeNull();
    expect(within(screen.getByTestId('task-details')).queryByText('Started from')).toBeNull();
  });

  it('a failed fetch is said on the task screen, with the reason, until dismissed for that task', async () => {
    await open(stale);
    const w = screen.getByTestId('base-warning');
    expect(w.textContent).toContain('Could not fetch ivan/shop; started from the state of 14 Nov 2026');
    expect(w.querySelector('.bw-reason')!.textContent).toBe('git fetch: Could not resolve host: github.com');
    fireEvent.click(within(w).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('base-warning')).toBeNull();
    // Details keep saying it.
    expect(within(details()).getByTestId('task-base').textContent).toContain('Could not fetch ivan/shop');
    cleanup();
    await open(stale);
    expect(screen.queryByTestId('base-warning')).toBeNull();
  });

  it('a task with a pipeline shows the warning above its feed', async () => {
    await open(stale, {
      pipeline: { id: 'p', name: 'P', createdAt: 1, updatedAt: 1, stages: [{ id: 's', name: 'S', does: '', result: '', substages: false, approval: true }] },
    });
    expect(screen.getByTestId('pipeline-task-view')).toBeTruthy();
    expect(screen.getByTestId('base-warning').textContent).toContain('Could not fetch ivan/shop');
  });
});

describe('who started a task', () => {
  it('task details name the agent that started it, and say nothing when the human did', async () => {
    await open(null, { startedBy: 'cto' });
    expect(within(details()).getByTestId('task-started-by').textContent).toBe('cto');
    cleanup();
    await open(null);
    expect(within(details()).queryByText('Started by')).toBeNull();
  });
});
