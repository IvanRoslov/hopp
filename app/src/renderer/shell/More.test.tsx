import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeAgent, makeProfile, makeProject, makeTask } from '../../../test/bridge';
import { makeSession } from '../../../test/fakeDaemon';
import { SENT_TIMEOUT_MS } from '../questions/Panel';

// The terminal is a marker that can be "closed" from the test.
const ends = vi.hoisted(() => ({ cbs: new Map<string, () => void>(), mounts: 0 }));
vi.mock('../terminal/Terminal', async () => {
  const { useEffect } = await import('react');
  return {
    Terminal: (p: { sessionId: string; onEnded?: () => void }) => {
      useEffect(() => {
        ends.mounts++;
        ends.cbs.set(p.sessionId, () => p.onEnded?.());
      }, []);
      return <div data-testid="terminal">terminal:{p.sessionId}</div>;
    },
  };
});

const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

async function mount(f: ReturnType<typeof fakeBridge>) {
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  ends.cbs.clear();
  ends.mounts = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const base = { projects: [makeProject('p')] };

describe('long-lived agents', () => {
  it('New agent creates one with a name, a model and a folder', async () => {
    const f = fakeBridge({ shell: { state: base, folders: ['/agents/docs'], profiles: [makeProfile('opus'), makeProfile('off', { enabled: false })] } });
    await mount(f);
    fireEvent.click(screen.getByText('New agent'));
    type(screen.getByLabelText('Name'), 'docs');
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createAgent).toHaveBeenCalledWith({ name: 'docs', profile: 'opus', dir: '/agents/docs' });
    expect(screen.getByTestId('work-view').textContent).toContain('docs is off');
  });

  it('a taken name shows next to the name', async () => {
    const f = fakeBridge({ shell: { state: { ...base, agents: [makeAgent('docs')] } } });
    await mount(f);
    fireEvent.click(screen.getByText('New agent'));
    type(screen.getByLabelText('Name'), 'docs');
    type(screen.getByLabelText('Folder'), '/x');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    const field = screen.getByLabelText('Name').closest('.field') as HTMLElement;
    expect(within(field).getByRole('alert').textContent).toBe('An agent with this name exists.');
  });

  it('an agent that is off shows its waiting mail and starts', async () => {
    const f = fakeBridge({ shell: { state: { ...base, agents: [makeAgent('docs')] }, mail: { docs: 3 } } });
    await mount(f);
    fireEvent.click(screen.getByTestId('agent-row'));
    expect(screen.getByText(/docs is off · 3 letters wait for it/)).toBeTruthy();
    expect(screen.getByText('The terminal appears once the agent is started.')).toBeTruthy();
    expect(screen.queryByTestId('terminal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await flush();
    expect(f.shell!.startAgent).toHaveBeenCalledWith('docs');
  });

  it('a running agent shows its terminal and stops after a confirmation', async () => {
    const f = fakeBridge({ sessions: [makeSession('cto', { activity: 'active' })], shell: { state: { ...base, agents: [makeAgent('cto')] } } });
    await mount(f);
    fireEvent.click(screen.getByTestId('agent-row'));
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:cto');
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByText('Stop agent'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();
    expect(f.shell!.stopAgent).toHaveBeenCalledWith('cto');
  });
});

describe('settings', () => {
  it('Models lists the daemon profiles read-only', async () => {
    const f = fakeBridge({ shell: { state: base, profiles: [makeProfile('opus', { description: 'Hard tasks' }), makeProfile('old', { enabled: false })] } });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    const rows = screen.getByTestId('settings-models').querySelectorAll('.set-row');
    expect([...rows].map((r) => r.textContent)).toEqual(['opusclaude · Hard tasksenabled', 'oldclaude · A profileoff']);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('Tools: preferences, switches, paid mark, usage on click, broken tools', async () => {
    const tool = (name: string, over = {}) => ({
      name, description: name + ' does things', via: 'command' as const, command: [], mcp_server: '', harnesses: [], environment: [], paid: false, enabled: true, dir: '', ...over,
    });
    const f = fakeBridge({
      shell: {
        state: base,
        tools: { tools: [tool('search'), tool('video', { paid: true, enabled: false })], broken: [{ name: 'bad', error: 'no TOOL.json' }] },
        rules: { text: 'Prefer search.', modifiedAt: 1_800_000_000 },
      },
    });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    await flush();
    const prefs = screen.getByLabelText('Preferences') as HTMLTextAreaElement;
    expect(prefs.value).toBe('Prefer search.');
    expect(screen.getByText(/^Saved /)).toBeTruthy();
    type(prefs, 'Prefer video.');
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await flush();
    expect(f.shell!.setToolRules).toHaveBeenCalledWith('Prefer video.');
    expect(screen.getByTestId('tool-video').textContent).toContain('paid — only after your go');
    fireEvent.click(screen.getByRole('switch', { name: 'video off' }));
    await flush();
    expect(f.shell!.setToolEnabled).toHaveBeenCalledWith('video', true);
    fireEvent.click(within(screen.getByTestId('tool-search')).getByText('search'));
    await flush();
    expect(screen.getByTestId('tool-search').textContent).toContain('Usage of search.');
    expect(screen.getByTestId('tool-broken-bad').textContent).toContain('Broken: no TOOL.json');
  });

  it('Lessons: new ones, then all; mark as done', async () => {
    const lesson = (id: number, status: 'new' | 'closed') => ({ id, from: 'w1', labels: { 'hopp.task': 't' }, body: 'Lesson ' + id, status, created_at: 1_800_000_000, closed_at: 0 });
    const f = fakeBridge({ shell: { state: { ...base, tasks: [makeTask('t', 'p', { title: 'Ship it' })] }, lessons: [lesson(1, 'new'), lesson(2, 'closed')] } });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByRole('tab', { name: 'Lessons' }));
    await flush();
    expect(screen.getByTestId('lesson-1').textContent).toContain('Ship it · w1');
    expect(screen.queryByTestId('lesson-2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as done' }));
    await flush();
    expect(f.shell!.closeLesson).toHaveBeenCalledWith(1);
    expect(screen.getByText('No new lessons.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lesson-filter'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'all' }));
    await flush();
    expect(screen.getByTestId('lesson-2')).toBeTruthy();
  });
});

describe('day-one fixes', () => {
  const task = () =>
    fakeBridge({
      sessions: [makeSession('orc')],
      shell: { state: { ...base, tasks: [makeTask('t', 'p', { title: 'Ship it', sessionId: 'orc' })] } },
    });

  it('a closed terminal can be reattached', async () => {
    const f = task();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    expect(ends.mounts).toBe(1);
    act(() => ends.cbs.get('orc')!());
    fireEvent.click(screen.getByRole('button', { name: 'Reattach' }));
    expect(ends.mounts).toBe(2);
    expect(screen.queryByRole('button', { name: 'Reattach' })).toBeNull();
  });

  it('"Sent" ends when the daemon cannot confirm the answer, or after a while', async () => {
    const q = { asked_at: 1, questions: [{ question: 'Run?', header: '', multi_select: false, options: [{ label: 'Yes' }] }] };
    const f = fakeBridge({ sessions: [makeSession('orc', { question: q })], shell: { state: { ...base, tasks: [makeTask('t', 'p', { sessionId: 'orc' })] } } });
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.click(screen.getByTestId('questions-button'));
    await flush();
    const block = () => screen.getByTestId('harness-question');
    fireEvent.click(within(block()).getByRole('button', { name: 'Yes' }));
    await flush();
    expect(block().textContent).toContain('Sent.');
    act(() => f.emit('session.quiz_answer_unconfirmed', 'orc'));
    expect(block().textContent).not.toContain('Sent.');
    expect(block().textContent).toContain('could not confirm');
    expect((within(block()).getByRole('button', { name: 'Yes' }) as HTMLButtonElement).disabled).toBe(false);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(within(block()).getByRole('button', { name: 'Yes' }));
    await flush();
    expect(block().textContent).toContain('Sent.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SENT_TIMEOUT_MS + 10);
    });
    expect(block().textContent).toContain('No confirmation yet');
  });
});

describe('double submit', () => {
  it('two quick Enters create one project', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('a')] } } });
    let release!: () => void;
    f.shell!.createProject.mockImplementationOnce(
      (input) => new Promise((r) => (release = () => r({ ok: true, value: makeProject('x', { name: input.name }) }))),
    );
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('New project'));
    type(screen.getByLabelText('Name'), 'X');
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await act(async () => release());
    await flush();
    expect(f.shell!.createProject).toHaveBeenCalledTimes(1);
  });
});
