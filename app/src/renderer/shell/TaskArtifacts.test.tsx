import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeProject, makeTask } from '../../../test/bridge';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';
import type { Artifact } from '../../shared/shell';

vi.mock('../terminal/Terminal', () => ({
  Terminal: (p: { sessionId: string }) => <div data-testid="terminal">terminal:{p.sessionId}</div>,
}));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const art = (id: number, name: string, version: number, over: Partial<Artifact> = {}): Artifact => ({
  id, name, version, filename: name + '.html', mime: 'text/html', size: 10, sha256: '', from: 'plain', scope: 'plain', labels: {}, created_at: id, ...over,
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

// A task without a pipeline whose agent published two versions of a board
// and asks about the second one.
async function mount() {
  const ask = makeAsk(7, 'plain', { body: 'Which numbers?', attachments: ['board@2'] });
  const artifacts = [art(1, 'board', 1), art(2, 'board', 2), art(3, 'notes', 1, { filename: 'notes.md', mime: 'text/markdown' })];
  const f = fakeBridge({
    sessions: [makeSession('plain')],
    asks: [ask],
    shell: {
      state: { projects: [makeProject('p')], tasks: [makeTask('plain', 'p', { title: 'Plain', sessionId: 'plain' })] },
      feeds: { plain: { posts: [], asks: [ask], artifacts } },
    },
  });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getAllByTestId('task-row').find((r) => r.dataset['id'] === 'plain')!);
  await flush();
  return f;
}

describe('the artifacts of a task without a pipeline', () => {
  it('has an Artifacts button that counts them and opens the grid and the viewer', async () => {
    await mount();
    expect(screen.getByTestId('work-view')).toBeTruthy();
    const button = screen.getByTestId('artifacts-button');
    expect(button.textContent).toBe('Artifacts · 2');
    fireEvent.click(button);
    const panel = screen.getByTestId('artifacts-panel');
    expect(within(panel).getByTestId('artifact-tile-board@2')).toBeTruthy();
    expect(within(panel).queryByTestId('artifact-tile-board@1')).toBeNull();
    expect(within(panel).queryByTestId('artifacts-stage')).toBeNull();
    expect(screen.getByTestId('terminal')).toBeTruthy();
    fireEvent.click(within(panel).getByTestId('artifact-tile-notes@1'));
    await flush();
    expect(screen.getByTestId('artifact-viewer').textContent).toContain('notes');
  });

  it('shows what an ask attaches as a tile that opens the artifact', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('questions-button'));
    await flush();
    const tile = within(screen.getByTestId('ask-7')).getByTestId('artifact-tile-board@2');
    fireEvent.click(tile);
    await flush();
    expect(screen.getByTestId('artifact-viewer').querySelector('iframe')?.getAttribute('src')).toBe('hopp-artifact://v/2');
    // The header button goes back to the grid.
    fireEvent.click(screen.getByTestId('artifacts-button'));
    fireEvent.click(screen.getByTestId('artifacts-button'));
    expect(screen.getByTestId('artifacts-panel')).toBeTruthy();
  });
});
