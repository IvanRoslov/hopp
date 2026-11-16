import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeAgent, makeProfile, makeProject, makeTask } from '../../../test/bridge';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';

vi.mock('../terminal/Terminal', () => ({
  Terminal: (p: { sessionId: string }) => <div data-testid="terminal">terminal:{p.sessionId}</div>,
}));

const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
});
afterEach(cleanup);

async function mount(f: ReturnType<typeof fakeBridge>) {
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('before the shell layer is wired', () => {
  it('keeps the skeleton session list', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    await mount(f);
    expect(screen.getByTestId('session-row').textContent).toBe('aidle');
  });
});

describe('first run', () => {
  it('shows only "Create your first project", then the new task form', async () => {
    const f = fakeBridge({ shell: true });
    await mount(f);
    expect(screen.getByRole('heading', { name: 'Create your first project' })).toBeTruthy();
    expect(screen.queryByText('New task')).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    type(screen.getByLabelText('Name'), 'Мой проект');
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('moy-proekt');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createProject).toHaveBeenCalledWith({
      name: 'Мой проект', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '',
    });
    expect(screen.getByLabelText('What needs to be done?')).toBeTruthy();
    expect(screen.getByTestId('pick-project').textContent).toContain('Мой проект');
  });
});

describe('project form', () => {
  it('the slug follows the name until edited, and errors sit next to their field', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('site')] } } });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('New project'));
    type(screen.getByLabelText('Name'), 'Site');
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('site');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    // The fake refuses a taken slug next to the slug field.
    const slugField = screen.getByLabelText('Slug').closest('.field')!;
    expect(within(slugField as HTMLElement).getByRole('alert').textContent).toBe('This slug is taken.');
    type(screen.getByLabelText('Slug'), 'site-2');
    type(screen.getByLabelText('Name'), 'Site two');
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('site-2');
  });

  it('opens Advanced for an error that belongs there, and sends its fields', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('a')] }, folders: ['/repos/ui'] } });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('New project'));
    type(screen.getByLabelText('Name'), 'Shop');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    type(screen.getByLabelText('Worktree for the orchestrator'), '/missing');
    fireEvent.click(screen.getByRole('button', { name: 'Hide advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(screen.getByLabelText('Worktree for the orchestrator')).toBeTruthy();
    expect(screen.getByText('This folder does not exist.')).toBeTruthy();
    type(screen.getByLabelText('Worktree for the orchestrator'), '/repos/shop');
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    await flush();
    type(screen.getByLabelText('Guardrails'), 'No paid actions.');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createProject).toHaveBeenLastCalledWith({
      name: 'Shop', description: '', orchestratorRepo: '/repos/shop', workerRepos: ['/repos/ui'], guardrails: 'No paid actions.',
    });
  });

  it('edits a project from Settings', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('site', { name: 'Site', description: 'old' })] } } });
    await mount(f);
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('Site'));
    type(screen.getByLabelText('Description'), 'new words');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(f.shell!.updateProject).toHaveBeenCalledWith('site', expect.objectContaining({ name: 'Site', slug: 'site', description: 'new words' }));
  });
});

describe('new task', () => {
  const seed = () =>
    fakeBridge({
      shell: {
        state: { projects: [makeProject('hopp', { name: 'hopp', orchestratorRepo: '/repos/hopp' }), makeProject('site')] },
        profiles: [makeProfile('opus'), makeProfile('sonnet'), makeProfile('old', { enabled: false })],
      },
    });

  it('offers only enabled profiles and launches with what was chosen', async () => {
    const f = seed();
    await mount(f);
    expect(screen.getByText('A new worktree of /repos/hopp at its current commit; uncommitted changes are not included.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pick-orchestrator'));
    expect(screen.getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual(['opus · A profile', 'sonnet · A profile']);
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]!);
    fireEvent.click(screen.getByTestId('pick-workers'));
    fireEvent.click(screen.getAllByRole('menuitemcheckbox')[1]!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('pick-workers').textContent).toContain('opus, sonnet');
    type(screen.getByLabelText('What needs to be done?'), 'Fix the login page\nIt loops.');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    type(screen.getByLabelText('Extra system prompt'), 'Be brief.');
    fireEvent.click(screen.getByRole('button', { name: 'Start the task' }));
    await flush();
    expect(f.shell!.createTask).toHaveBeenCalledWith({
      projectSlug: 'hopp', brief: 'Fix the login page\nIt loops.', orchestratorProfile: 'sonnet', workerProfiles: ['opus', 'sonnet'], extraSystemPrompt: 'Be brief.',
    });
    // The new task opens, starting.
    expect(screen.getByTestId('zone-right').textContent).toContain('Fix the login page');
    expect(screen.getAllByText('Starting…').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('task-row').map((r) => r.textContent)).toEqual(['Fix the login pagestarting']);
  });

  it('a taken session name shows next to that field, in More', async () => {
    const f = seed();
    f.db.sessions = [makeSession('fix-it')];
    await mount(f);
    type(screen.getByLabelText('What needs to be done?'), 'Fix it');
    fireEvent.click(screen.getByRole('button', { name: 'Start the task' }));
    await flush();
    const field = screen.getByLabelText('Session name').closest('.field') as HTMLElement;
    expect(within(field).getByRole('alert').textContent).toBe('A session named fix-it exists.');
  });

  it('Cmd+Enter starts the task', async () => {
    const f = seed();
    await mount(f);
    const box = screen.getByLabelText('What needs to be done?');
    type(box, 'Write docs');
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await flush();
    expect(f.shell!.createTask).toHaveBeenCalledTimes(1);
  });
});

describe('left column', () => {
  it('groups active tasks by project, shows Recent, agents and waiting rows', async () => {
    const f = fakeBridge({
      sessions: [
        makeSession('t-a', { activity: 'active' }),
        makeSession('t-b', { activity: 'ready' }),
        makeSession('t-b-w', { parent: 't-b', question: { asked_at: 1, questions: [{ question: 'Run tests?', header: '', multi_select: false, options: [{ label: 'Yes' }] }] } }),
        makeSession('cto', { activity: 'active' }),
      ],
      asks: [makeAsk(3, 't-a', { body: 'Ready for review' })],
      shell: {
        state: {
          projects: [makeProject('one', { createdAt: 1 }), makeProject('two', { createdAt: 2 }), makeProject('empty', { createdAt: 3 })],
          tasks: [
            makeTask('t-a', 'two', { title: 'Task A' }),
            makeTask('t-b', 'one', { title: 'Task B' }),
            makeTask('t-old', 'one', { title: 'Old one', status: 'finished', finishedAt: 5 }),
          ],
          agents: [makeAgent('cto'), makeAgent('docs')],
        },
        mail: { docs: 3 },
      },
    });
    await mount(f);
    const side = screen.getByTestId('zone-left');
    expect([...side.querySelectorAll('.project-head')].map((e) => e.textContent)).toEqual(['one', 'two']);
    expect(screen.getAllByTestId('task-row').map((r) => r.textContent)).toEqual(['Task B•waiting for me', 'Task A•waiting for me']);
    expect(screen.getAllByTestId('recent-row').map((r) => r.textContent)).toEqual(['Old one']);
    expect(screen.getAllByTestId('waiting-row').map((r) => r.textContent)).toEqual(['Run tests?Task B', 'Ready for reviewTask A']);
    expect(screen.getAllByTestId('agent-row').map((r) => r.textContent)).toEqual(['cto', 'docsoff · 3']);
  });

  it('a waiting row opens its task with the questions open, on that session', async () => {
    const q = { asked_at: 1, questions: [{ question: 'Run tests?', header: '', multi_select: false, options: [{ label: 'Yes' }, { label: 'No' }] }] };
    const f = fakeBridge({
      sessions: [makeSession('t-b'), makeSession('t-b-w', { parent: 't-b', question: q })],
      shell: { state: { projects: [makeProject('one')], tasks: [makeTask('t-b', 'one', { title: 'Task B' })] } },
    });
    await mount(f);
    fireEvent.click(screen.getByTestId('waiting-row'));
    await flush();
    expect(screen.getByTestId('zone-middle')).toBeTruthy();
    expect(screen.getByTestId('session-picker').textContent).toContain('t-b-w · waiting for input');
    expect(screen.getByTestId('questions-button').textContent).toBe('Questions · 1');
    fireEvent.click(within(screen.getByTestId('harness-question')).getByRole('button', { name: 'No' }));
    await flush();
    expect(f.daemon.answerQuiz).toHaveBeenCalledWith('t-b-w', { answers: [{ question_index: 0, option_indices: [1] }] });
  });

  it('shows a failed session list load', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('one')] } } });
    f.daemon.listSessions.mockRejectedValue(new Error("Error invoking remote method 'daemon:list-sessions': Error: boom"));
    await mount(f);
    expect(screen.getByRole('alert').textContent).toContain('Could not load sessions');
  });
});

describe('task view', () => {
  const setup = (over: Parameters<typeof makeSession>[1] = {}) =>
    fakeBridge({
      sessions: [makeSession('orc', { created_at: 1, ...over }), makeSession('w1', { parent: 'orc', created_at: 2, activity: 'active' }), makeSession('w2', { parent: 'orc', created_at: 3, state: 'done' })],
      shell: { state: { projects: [makeProject('p')], tasks: [makeTask('t', 'p', { title: 'Ship it', sessionId: 'orc' })] } },
    });

  it('has the title, Questions, the session picker with states, and the terminal', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    expect(screen.getByTestId('questions-button').textContent).toBe('Questions');
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:orc');
    fireEvent.click(screen.getByTestId('session-picker'));
    expect(screen.getAllByRole('menuitemradio').map((b) => b.textContent)).toEqual(['orc · idle', 'w1 · working', 'w2 · exited']);
    fireEvent.click(screen.getByText('w1 · working'));
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:w1');
  });

  it('Stop asks first, naming the task and its child sessions', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByText('Stop task'));
    expect(screen.getByRole('alertdialog').textContent).toContain('Stop Ship it and its child sessions (2)?');
    expect(f.shell!.stopTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();
    expect(f.shell!.stopTask).toHaveBeenCalledWith('t');
  });

  it('a stopped task says so and resumes', async () => {
    const f = setup({ state: 'killed' });
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByText(/Ship it is stopped/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await flush();
    expect(f.shell!.resumeTask).toHaveBeenCalledWith('t');
  });

  it('Finish moves the task to Recent', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByText('Finish task'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await flush();
    expect(screen.queryByTestId('task-row')).toBeNull();
    expect(screen.getAllByTestId('recent-row').map((r) => r.textContent)).toEqual(['Ship it']);
    expect(screen.getByText(/Finished\. The worktree is kept/)).toBeTruthy();
  });

  it('opening the questions keeps the same terminal', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    const before = screen.getByTestId('terminal');
    fireEvent.click(screen.getByTestId('questions-button'));
    expect(screen.getByTestId('zone-middle')).toBeTruthy();
    expect(screen.getByTestId('terminal')).toBe(before);
    expect(screen.getByText('No questions.')).toBeTruthy();
  });

  it('Task details open in the column', async () => {
    const f = setup();
    await mount(f);
    fireEvent.click(screen.getByTestId('task-row'));
    fireEvent.click(screen.getByTestId('actions-menu'));
    fireEvent.click(screen.getByText('Task details'));
    expect(screen.getByTestId('task-details').textContent).toContain('Do t');
  });
});

describe('theme', () => {
  it('the switch flips the theme and remembers it', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('p')] } } });
    await mount(f);
    const before = document.documentElement.dataset['theme'] ?? 'dark';
    fireEvent.click(screen.getByRole('button', { name: 'Switch theme' }));
    const after = document.documentElement.dataset['theme'] ?? 'dark';
    expect(after).not.toBe(before);
    expect(localStorage.getItem('hopp.theme')).toBe(after);
  });
});
