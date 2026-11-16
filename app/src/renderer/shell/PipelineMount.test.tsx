import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeProject, makeTask } from '../../../test/bridge';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';
import type { Pipeline } from '../../shared/shell';

vi.mock('../terminal/Terminal', () => ({
  Terminal: (p: { sessionId: string }) => <div data-testid="terminal">terminal:{p.sessionId}</div>,
}));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const pipeline: Pipeline = {
  id: 'pl', name: 'Two stages', createdAt: 1, updatedAt: 1,
  stages: [
    { id: 's1', name: 'Script', does: '', result: '', substages: false, approval: true },
    { id: 's2', name: 'Assembly', does: '', result: '', substages: false, approval: true },
  ],
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function setup(over: { question?: boolean } = {}) {
  const q = { asked_at: 1, questions: [{ question: 'Allow?', header: '', multi_select: false, options: [{ label: 'Yes' }] }] };
  return fakeBridge({
    sessions: [makeSession('orc', over.question ? { question: q } : {}), makeSession('plain')],
    asks: [makeAsk(5, 'orc', { body: 'Script ready for review', labels: { 'hopp.task': 'promo', 'hopp.kind': 'submission', 'hopp.stage': 's1' }, options: ['Accept', 'Return'] })],
    shell: {
      state: {
        projects: [makeProject('p')],
        pipelines: [pipeline],
        tasks: [makeTask('promo', 'p', { title: 'Promo', sessionId: 'orc', pipeline }), makeTask('plain', 'p', { title: 'Plain', sessionId: 'plain' })],
      },
      feeds: { promo: { posts: [], asks: [], artifacts: [] } },
    },
  });
}

async function mount(f: ReturnType<typeof fakeBridge>) {
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
}

describe('a task with a pipeline', () => {
  it('opens the pipeline view; a task without one keeps the terminal view', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getAllByTestId('task-row').find((r) => r.dataset['id'] === 'plain')!);
    expect(screen.getByTestId('work-view')).toBeTruthy();
    expect(screen.queryByTestId('pipeline-task-view')).toBeNull();
    fireEvent.click(screen.getAllByTestId('task-row').find((r) => r.dataset['id'] === 'promo')!);
    await flush();
    expect(screen.getByTestId('pipeline-task-view')).toBeTruthy();
    expect(screen.queryByTestId('questions-button')).toBeNull();
  });

  it('the Terminal panel holds the session picker and the terminal', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getAllByTestId('task-row').find((r) => r.dataset['id'] === 'promo')!);
    await flush();
    fireEvent.click(screen.getByTestId('terminal-button'));
    await flush();
    expect(screen.getByTestId('pipeline-panel').textContent).toContain('orc · idle');
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:orc');
  });

  it('Task details open in the right panel', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getAllByTestId('task-row').find((r) => r.dataset['id'] === 'promo')!);
    await flush();
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByText('Task details'));
    await flush();
    expect(screen.getByTestId('pipeline-panel').textContent).toContain('Do promo');
  });

  it('a screen question of a pipeline task opens its terminal', async () => {
    const f = setup({ question: true });
    await mount(f);
    fireEvent.click(screen.getAllByTestId('waiting-row').find((r) => r.textContent?.startsWith('Allow?'))!);
    await flush();
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:orc');
  });
});
