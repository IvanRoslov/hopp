import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskBase } from '../../shared/shell';
import { fakeBridge, makeAgent, makeProject, makeTask } from '../../../test/bridge';
import { makeSession } from '../../../test/fakeDaemon';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function openTask(over: { state?: 'running' | 'killed'; base?: TaskBase | null } = {}) {
  const f = fakeBridge({
    sessions: [makeSession('t1', { state: over.state ?? 'running', activity: 'active' }), makeSession('t1-w', { parent: 't1' })],
    shell: { state: { projects: [makeProject('p')], tasks: [makeTask('t1', 'p', { title: 'Fix it', sessionId: 't1', base: over.base ?? null })] } },
  });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getByTestId('task-row'));
  await flush();
  return f;
}
const row = () => screen.getByTestId('work-view').querySelector('.top-row') as HTMLElement;
// What the header row holds, in order: the title, the buttons, the picker, the status.
const order = () =>
  [...row().querySelectorAll('.name, button, .top-status')].map((el) =>
    el.classList.contains('name') ? 'title' : el.classList.contains('top-status') ? 'status' : el.getAttribute('data-testid') ?? el.textContent,
  );

describe('the work view header', () => {
  it('is one row: title, Stop, Questions, the picker, then the menu; no line above the terminal', async () => {
    await openTask();
    expect(order()).toEqual(['title', 'task-stop', 'questions-button', 'session-picker', 'actions-menu']);
    expect(screen.getByTestId('work-view').querySelector('.top-alert')).toBeNull();
    expect(screen.getByTestId('work-view').querySelector('.term-bar, .status-line')).toBeNull();
  });

  it('a stopped task offers Resume before Questions and says so quietly, whole in the tooltip', async () => {
    await openTask({ state: 'killed' });
    expect(order()).toEqual(['title', 'task-resume', 'questions-button', 'session-picker', 'status', 'actions-menu']);
    const st = screen.getByTestId('work-status');
    expect(st.textContent).toBe('Stopped.');
    expect(st.getAttribute('title')).toBe('Stopped.');
    fireEvent.click(screen.getByTestId('actions-menu'));
    expect(screen.queryByRole('menuitem', { name: 'Resume' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Finish task' })).toBeTruthy();
  });

  it('with a column open the picker moves to the terminal head', async () => {
    await openTask();
    fireEvent.click(screen.getByTestId('questions-button'));
    await flush();
    expect(within(row()).queryByTestId('session-picker')).toBeNull();
    const head = screen.getByTestId('work-view').querySelector('.term-label') as HTMLElement;
    expect(within(head).getByTestId('session-picker')).toBeTruthy();
  });

  it('a fetch warning takes a second line only while it is there', async () => {
    const base: TaskBase = { ref: 'origin/main', commit: 'abc1234', committedAt: 1, fetched: false, warning: 'git fetch: offline' };
    await openTask({ base });
    const second = screen.getByTestId('work-view').querySelector('.top-alert') as HTMLElement;
    expect(within(second).getByTestId('base-warning')).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByTestId('work-view').querySelector('.top-alert')).toBeNull();
  });

  it('an agent that is off: title, Start, Questions, "Off · letters"; Stop when running', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('p')], agents: [makeAgent('lepsto-cto')] }, mail: { 'lepsto-cto': 2 } } });
    render(<ShellApp bridge={f.bridge} />);
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId('agent-row'));
    await flush();
    expect(order()).toEqual(['title', 'agent-start', 'questions-button', 'status', 'actions-menu']);
    expect(screen.getByTestId('work-status').textContent).toBe('Off · 2 letters wait for it');
  });
});
