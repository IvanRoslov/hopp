import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeAgent, makeProject } from '../../../test/bridge';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const TMUX = 'A tmux session named cto already runs outside hopp. Choose another name, or close that session.';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

async function open(seed: { mail?: Record<string, number>; foreignTmux?: string[]; agents?: string[] } = {}) {
  const f = fakeBridge({
    shell: { state: { projects: [makeProject('p')], agents: (seed.agents ?? ['cto']).map((n) => makeAgent(n)) }, mail: seed.mail, foreignTmux: seed.foreignTmux },
  });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getAllByTestId('agent-row')[0]!);
  await flush();
  return f;
}
const statusLine = () => screen.getByTestId('work-view').querySelector('.status-line') as HTMLElement;

describe('an agent name a tmux session outside hopp holds', () => {
  it('New agent says so next to Name', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('p')] }, foreignTmux: ['cto'] } });
    render(<ShellApp bridge={f.bridge} />);
    await flush();
    await flush();
    fireEvent.click(screen.getByText('New agent'));
    type(screen.getByLabelText('Name'), 'cto');
    type(screen.getByLabelText('Folder'), '/x');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    const field = screen.getByLabelText('Name').closest('.field') as HTMLElement;
    expect(within(field).getByRole('alert').textContent).toBe(TMUX);
  });

  it('Start says it in words, with Rename and Remove agent beside it', async () => {
    await open({ foreignTmux: ['cto'] });
    fireEvent.click(within(statusLine()).getByRole('button', { name: 'Start' }));
    await flush();
    const alert = within(statusLine()).getByRole('alert');
    expect(alert.textContent).toContain(TMUX);
    expect(alert.textContent).not.toContain('session id is taken');
    expect(within(alert).getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Remove agent' })).toBeTruthy();
  });

  it('Rename from there opens the details with the new-name field', async () => {
    const f = await open({ foreignTmux: ['cto'] });
    fireEvent.click(within(statusLine()).getByRole('button', { name: 'Start' }));
    await flush();
    fireEvent.click(within(statusLine()).getByRole('button', { name: 'Rename' }));
    await flush();
    const form = screen.getByTestId('rename-agent');
    type(within(form).getByLabelText('New name'), 'boss');
    fireEvent.click(within(form).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(f.shell!.renameAgent).toHaveBeenCalledWith('cto', 'boss');
    expect(screen.getByTestId('agent-details').textContent).toContain('boss');
    expect(screen.getByTestId('work-view').textContent).toContain('boss is off');
  });
});

describe('remove beside Start', () => {
  it('a quiet Remove asks first, then removes', async () => {
    const f = await open();
    fireEvent.click(screen.getByTestId('agent-remove'));
    const ask = within(statusLine()).getByRole('alertdialog');
    expect(ask.textContent).toContain('Remove cto? Its folder stays as it is.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(f.shell!.removeAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('agent-remove'));
    fireEvent.click(within(statusLine()).getByRole('button', { name: 'Remove' }));
    await flush();
    expect(f.shell!.removeAgent).toHaveBeenCalledWith('cto');
  });

  it('waiting mail is said in the confirmation, here and in the menu', async () => {
    await open({ mail: { cto: 2 } });
    fireEvent.click(screen.getByTestId('agent-remove'));
    expect(within(statusLine()).getByRole('alertdialog').textContent).toContain('2 letters wait in its mailbox, so the mailbox stays.');
    fireEvent.click(within(statusLine()).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove agent' }));
    expect(screen.getByRole('alertdialog', { name: /2 letters wait in its mailbox/ })).toBeTruthy();
  });
});

describe('rename in Agent details', () => {
  const details = () => {
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent details' }));
    return screen.getByTestId('agent-details');
  };

  it('a taken name is refused next to the field, as in New agent', async () => {
    const f = await open({ agents: ['cto', 'ops'] });
    fireEvent.click(within(details()).getByRole('button', { name: 'Rename' }));
    const form = screen.getByTestId('rename-agent');
    type(within(form).getByLabelText('New name'), 'ops');
    fireEvent.click(within(form).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(within(form).getByRole('alert').textContent).toBe('An agent with this name exists.');
    expect(f.shell!.renameAgent).toHaveBeenCalledTimes(1);
  });

  it('with mail waiting it says the letters stay under the old name before renaming', async () => {
    const f = await open({ mail: { cto: 3 } });
    fireEvent.click(within(details()).getByRole('button', { name: 'Rename' }));
    const form = screen.getByTestId('rename-agent');
    type(within(form).getByLabelText('New name'), 'boss');
    fireEvent.click(within(form).getByRole('button', { name: 'Rename' }));
    await flush();
    expect(f.shell!.renameAgent).not.toHaveBeenCalled();
    expect(within(form).getByRole('status').textContent).toBe(
      '3 letters stay under the old name cto: hopp cannot move mail, and nothing is deleted. boss starts with an empty mailbox.',
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Rename anyway' }));
    await flush();
    expect(f.shell!.renameAgent).toHaveBeenCalledWith('cto', 'boss');
  });

  it('a running agent cannot be renamed', async () => {
    const { makeSession } = await import('../../../test/fakeDaemon');
    const f = fakeBridge({ sessions: [makeSession('cto', { activity: 'active' })], shell: { state: { projects: [makeProject('p')], agents: [makeAgent('cto')] } } });
    render(<ShellApp bridge={f.bridge} />);
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId('agent-row'));
    await flush();
    expect(within(details()).queryByRole('button', { name: 'Rename' })).toBeNull();
    fireEvent.click(screen.getByTestId('actions-menu'));
    expect(screen.queryByRole('menuitem', { name: 'Rename…' })).toBeNull();
  });
});
