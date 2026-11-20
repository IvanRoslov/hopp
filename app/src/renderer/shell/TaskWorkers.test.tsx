import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../../shared/shell';
import { fakeShell, makeProfile, makeProject, makeTask } from '../../../test/bridge';
import { TaskDetails } from './TaskView';

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

afterEach(cleanup);

// The details of a task, with the Add control for its workers.
async function details(over: Partial<Task> = {}) {
  const task = makeTask('t1', 'shop', { workerProfiles: ['sonnet'], ...over });
  const f = fakeShell({
    state: { projects: [makeProject('shop')], tasks: [task] },
    profiles: [makeProfile('sonnet'), makeProfile('opus-max', { position: 1 }), makeProfile('off', { enabled: false, position: 2 })],
  });
  render(<TaskDetails task={task} project={makeProject('shop')} shell={f.shell} />);
  await flush();
  return f;
}

describe('adding workers from the task details', () => {
  it('offers the enabled profiles the task does not have, and adds the picked ones', async () => {
    const f = await details();
    fireEvent.click(screen.getByTestId('add-workers'));
    const offered = screen.getAllByRole('menuitemcheckbox').map((b) => b.textContent);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain('opus-max');
    expect(screen.queryByTestId('add-workers-confirm')).toBeNull();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /opus-max/ }));
    const confirm = screen.getByTestId('add-workers-confirm');
    expect(confirm.textContent).toBe('Add 1');
    fireEvent.click(confirm);
    await flush();
    expect(f.shell.addTaskWorkers).toHaveBeenCalledWith('t1', ['opus-max']);
    expect(screen.queryByTestId('add-workers-confirm')).toBeNull();
    expect(screen.queryByTestId('add-workers-error')).toBeNull();
  });

  it('shows a refusal in the row', async () => {
    const f = await details();
    f.shell.addTaskWorkers.mockResolvedValueOnce({ ok: false, error: { code: 'workers_message', message: 'opus-max saved for t1, but telling the orchestrator failed' } });
    fireEvent.click(screen.getByTestId('add-workers'));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /opus-max/ }));
    fireEvent.click(screen.getByTestId('add-workers-confirm'));
    await flush();
    expect(screen.getByTestId('add-workers-error').textContent).toContain('telling the orchestrator failed');
  });

  it('a finished task, or details without the bridge, show the workers as plain text', async () => {
    await details({ status: 'finished' });
    expect(screen.queryByTestId('add-workers')).toBeNull();
    expect(within(screen.getByTestId('task-details')).getByText('sonnet')).toBeTruthy();
    cleanup();
    render(<TaskDetails task={makeTask('t2', 'shop', { workerProfiles: ['sonnet'] })} />);
    expect(screen.queryByTestId('add-workers')).toBeNull();
  });
});
