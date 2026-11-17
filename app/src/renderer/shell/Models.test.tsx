import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../../shared/shell';
import { fakeBridge, makeProfile, makeProject, type ShellSeed } from '../../../test/bridge';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const PROFILES: ModelProfile[] = [
  makeProfile('claude-opus', { agent: 'claude-code', model: 'opus', description: 'Hard work\nand orchestration', isDefault: true, position: 0 }),
  makeProfile('kimi-k3', { agent: 'kimi-code', model: 'kimi-code/k3', description: 'Понятные задачи по кодингу', position: 1 }),
  makeProfile('codex-sol', { agent: 'codex', model: 'gpt-6-sol', effort: 'xhigh', description: '', position: 2 }),
  makeProfile('deepseek-pro', { agent: 'deepseek', model: 'deepseek-v4-pro', description: '', enabled: false, position: 3 }),
];

async function openModels(extra: Partial<ShellSeed> = {}) {
  const f = fakeBridge({ shell: { state: { projects: [makeProject('p')] }, profiles: PROFILES, ...extra } });
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
  fireEvent.click(screen.getByText('Settings'));
  fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
  await flush();
  return f;
}
const group = (title: 'on' | 'off') => screen.queryByRole('region', { name: `Profiles ${title}` });
const names = (title: 'on' | 'off') => {
  const g = group(title);
  return g ? within(g).getAllByTestId('model-row').map((r) => r.getAttribute('data-name')) : [];
};
const row = (name: string) => screen.getAllByTestId('model-row').find((r) => r.getAttribute('data-name') === name)!;
const menu = async (name: string, item: string) => {
  fireEvent.click(within(row(name)).getByTestId(`model-menu-${name}`));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
  await flush();
};

describe('Settings → Models', () => {
  it('groups the profiles on, then off, with the harness as a tag and the default marked', async () => {
    await openModels();
    expect(names('on')).toEqual(['claude-opus', 'kimi-k3', 'codex-sol']);
    expect(names('off')).toEqual(['deepseek-pro']);
    const opus = row('claude-opus');
    expect(within(opus).getByText('claude-code').className).toBe('tag');
    expect(within(opus).getByText('Default')).toBeTruthy();
    expect(opus.querySelector('.mr-desc')!.textContent).toBe('Hard work\nand orchestration');
    expect(row('codex-sol').querySelector('.mr-sub')!.textContent).toBe('gpt-6-sol');
    expect(within(row('codex-sol')).getByTestId('effort-tag').textContent).toBe('effort: xhigh');
    expect(within(row('kimi-k3')).queryByText('Default')).toBeNull();
    expect((within(row('deepseek-pro')).getByRole('switch') as HTMLElement).getAttribute('aria-checked')).toBe('false');
  });

  it('a switch turns a profile on or off and the groups follow', async () => {
    const f = await openModels();
    fireEvent.click(within(row('deepseek-pro')).getByRole('switch', { name: 'Use deepseek-pro' }));
    await flush();
    expect(f.shell!.setProfileEnabled).toHaveBeenCalledWith('deepseek-pro', true);
    expect(names('on')).toContain('deepseek-pro');
    expect(group('off')).toBeNull();
    fireEvent.click(within(row('kimi-k3')).getByRole('switch'));
    await flush();
    expect(names('off')).toEqual(['kimi-k3']);
  });

  it('the default cannot be switched off: the reason is next to its row; another can be made default', async () => {
    await openModels();
    fireEvent.click(within(row('claude-opus')).getByRole('switch'));
    await flush();
    expect(within(row('claude-opus')).getByRole('alert').textContent).toContain('make another one the default first');
    await menu('kimi-k3', 'Make default');
    expect(within(row('kimi-k3')).getByText('Default')).toBeTruthy();
    expect(within(row('claude-opus')).queryByText('Default')).toBeNull();
    // Its refusal is gone once the profile changed.
    expect(within(row('claude-opus')).queryByRole('alert')).toBeNull();
    // An off profile is not offered as the default.
    fireEvent.click(within(row('deepseek-pro')).getByTestId('model-menu-deepseek-pro'));
    expect(screen.queryByRole('menuitem', { name: 'Make default' })).toBeNull();
  });

  it('edits a description in place, many lines and Cyrillic; Cancel leaves it', async () => {
    const f = await openModels();
    await menu('kimi-k3', 'Edit…');
    const box = within(row('kimi-k3')).getByLabelText('Description');
    type(box, 'Воркеры по коду.\nНе для архитектуры.');
    fireEvent.click(within(row('kimi-k3')).getByRole('button', { name: 'Save' }));
    await flush();
    expect(f.shell!.updateProfile).toHaveBeenCalledWith('kimi-k3', { description: 'Воркеры по коду.\nНе для архитектуры.' });
    expect(row('kimi-k3').querySelector('.mr-desc')!.textContent).toBe('Воркеры по коду.\nНе для архитектуры.');
    await menu('kimi-k3', 'Edit…');
    type(within(row('kimi-k3')).getByLabelText('Description'), 'thrown away');
    fireEvent.click(within(row('kimi-k3')).getByRole('button', { name: 'Cancel' }));
    expect(row('kimi-k3').querySelector('.mr-desc')!.textContent).toBe('Воркеры по коду.\nНе для архитектуры.');
  });

  it('offers the efforts the harness has for the model, and shows a refusal next to the row', async () => {
    const f = await openModels({
      catalog: [{ agent: 'codex', source: 'codex', warning: '', models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', description: '', main: true, efforts: ['low', 'high', 'xhigh', 'bogus'], known: true }] }],
    });
    await menu('kimi-k3', 'Edit…');
    await flush();
    expect(within(row('kimi-k3')).queryByTestId('effort-kimi-k3')).toBeNull();
    fireEvent.click(within(row('kimi-k3')).getByRole('button', { name: 'Cancel' }));
    await menu('codex-sol', 'Edit…');
    await flush();
    fireEvent.click(within(row('codex-sol')).getByTestId('effort-codex-sol'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'high' }));
    fireEvent.click(within(row('codex-sol')).getByRole('button', { name: 'Save' }));
    await flush();
    expect(f.shell!.updateProfile).toHaveBeenLastCalledWith('codex-sol', { description: '', effort: 'high' });
    expect(within(row('codex-sol')).getByTestId('effort-tag').textContent).toBe('effort: high');
    await menu('codex-sol', 'Edit…');
    await flush();
    fireEvent.click(within(row('codex-sol')).getByTestId('effort-codex-sol'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'bogus' }));
    fireEvent.click(within(row('codex-sol')).getByRole('button', { name: 'Save' }));
    await flush();
    expect(within(row('codex-sol')).getByRole('alert').textContent).toContain('does not take effort');
    // The editor stays open with what was typed.
    expect(within(row('codex-sol')).getByLabelText('Description')).toBeTruthy();
  });

  it('moves a profile up and down within its group', async () => {
    const f = await openModels();
    await menu('codex-sol', 'Move up');
    expect(f.shell!.moveProfile).toHaveBeenCalledWith('codex-sol', 1);
    expect(names('on')).toEqual(['claude-opus', 'codex-sol', 'kimi-k3']);
    await menu('claude-opus', 'Move down');
    expect(names('on')).toEqual(['codex-sol', 'claude-opus', 'kimi-k3']);
    fireEvent.click(within(row('codex-sol')).getByTestId('model-menu-codex-sol'));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).toBeNull();
  });

  it('removes a profile after a confirmation; one in use says who uses it', async () => {
    await openModels({ profilesInUse: ['claude-opus'] });
    await menu('deepseek-pro', 'Remove…');
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('Remove the profile deepseek-pro?');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await flush();
    expect(group('off')).toBeNull();
    await menu('claude-opus', 'Remove…');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await flush();
    expect(within(row('claude-opus')).getByRole('alert').textContent).toContain('used by the running session lead');
  });

  it('imports models: progress, "Added N", the new rows marked, failures listed', async () => {
    let finish: () => void = () => {};
    const added = [
      makeProfile('codex-gpt-6-luna', { agent: 'codex', model: 'gpt-6-luna', enabled: false, position: 4, description: 'Fast and affordable' }),
      makeProfile('kimi-k3-256k', { agent: 'kimi-code', model: 'kimi-code/k3-256k', enabled: false, position: 5 }),
    ];
    const f = await openModels({ importResult: { added, skipped: 7, failed: [{ agent: 'pi', reason: 'pi is not installed' }] } });
    const real = f.shell!.importModels.getMockImplementation()!;
    f.shell!.importModels.mockImplementationOnce(() => new Promise((res) => (finish = () => res(real()))));
    fireEvent.click(screen.getByTestId('import-models'));
    await flush();
    expect(screen.getByTestId('import-models').textContent).toBe(' Importing…');
    expect((screen.getByTestId('import-models') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await flush();
    const note = screen.getByTestId('import-note');
    expect(note.textContent).toContain('Added 2 models, switched off: turn on the ones you want.');
    expect(within(note).getByText('pi').className).toBe('tag');
    expect(note.textContent).toContain('pi is not installed');
    expect(names('off')).toEqual(['deepseek-pro', 'codex-gpt-6-luna', 'kimi-k3-256k']);
    expect(row('codex-gpt-6-luna').className).toContain('fresh');
    expect(within(row('codex-gpt-6-luna')).getByText('New')).toBeTruthy();
    expect(row('deepseek-pro').className).not.toContain('fresh');
  });

  it('an import with nothing new says so', async () => {
    await openModels({ importResult: { added: [], skipped: 12, failed: [] } });
    fireEvent.click(screen.getByTestId('import-models'));
    await flush();
    await flush();
    expect(screen.getByTestId('import-note').textContent).toContain('Nothing new');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('import-note')).toBeNull();
  });
});

describe('forms offer only profiles that are on', () => {
  it('New task follows a change, and says when the remembered profile is switched off', async () => {
    localStorage.setItem('hopp.newTask.last', JSON.stringify({ project: 'p', orchestrator: 'kimi-k3', workers: ['kimi-k3', 'codex-sol'] }));
    const f = fakeBridge({ shell: { state: { projects: [makeProject('p')] }, profiles: PROFILES } });
    render(<ShellApp bridge={f.bridge} />);
    await flush();
    await flush();
    expect(screen.getByTestId('pick-orchestrator').textContent).toBe('Orchestrator: kimi-k3');
    expect(screen.queryByTestId('profiles-switched-off')).toBeNull();
    // Switched off in Settings (through the app): the form refreshes.
    await act(async () => {
      await f.shell!.setProfileEnabled('kimi-k3', false);
    });
    await flush();
    expect(screen.getByTestId('pick-orchestrator').textContent).toBe('Orchestrator: claude-opus');
    expect(screen.getByTestId('pick-workers').textContent).toBe('Workers: codex-sol');
    expect(screen.getByTestId('profiles-switched-off').textContent).toBe(
      'kimi-k3 is switched off in Settings → Models, so the form no longer offers it.',
    );
    fireEvent.click(screen.getByTestId('pick-orchestrator'));
    expect(screen.queryByRole('menuitemradio', { name: /kimi-k3/ })).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /deepseek-pro/ })).toBeNull();
  });

  it('the agent form falls back visibly when its profile is switched off', async () => {
    const f = fakeBridge({ shell: { state: { projects: [makeProject('p')] }, profiles: PROFILES } });
    render(<ShellApp bridge={f.bridge} />);
    await flush();
    await flush();
    fireEvent.click(screen.getByText('New agent'));
    fireEvent.click(screen.getByTestId('pick-agent-profile'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /codex-sol/ }));
    await act(async () => {
      await f.shell!.setProfileEnabled('codex-sol', false);
    });
    await flush();
    expect(screen.getByTestId('pick-agent-profile').textContent).toContain('claude-opus');
    expect(screen.getByText('codex-sol is switched off in Settings → Models; claude-opus is used instead.')).toBeTruthy();
  });
});

describe('effort on every profile', () => {
  const catalog = [
    { agent: 'kimi-code', source: 'kimi', warning: '', models: [{ id: 'kimi-code/k3', name: 'K3', description: '', main: true, efforts: ['low', 'high', 'max'], known: true }] },
    { agent: 'deepseek', source: 'deepseek', warning: '', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro', description: '', main: true, efforts: [], known: true }] },
  ];

  it('a row shows its level, "default" where the model has levels, nothing where it has none', async () => {
    await openModels({ catalog });
    await flush();
    expect(within(row('codex-sol')).getByTestId('effort-tag').textContent).toBe('effort: xhigh');
    expect(within(row('kimi-k3')).getByTestId('effort-tag').textContent).toBe('effort: default');
    expect(within(row('deepseek-pro')).queryByTestId('effort-tag')).toBeNull();
    // A model the catalog does not list says nothing either.
    expect(within(row('claude-opus')).queryByTestId('effort-tag')).toBeNull();
  });

  it('the New task pickers tell two profiles of one model apart by effort', async () => {
    const profiles = [...PROFILES, makeProfile('kimi-k3-max', { agent: 'kimi-code', model: 'kimi-code/k3', effort: 'max', description: 'То же, трудные места', position: 4 })];
    await openModels({ catalog, profiles });
    fireEvent.click(screen.getAllByRole('button', { name: 'New task' })[0]!);
    await flush();
    fireEvent.click(screen.getByTestId('pick-orchestrator'));
    const tagOf = (n: string) => screen.getAllByRole('menuitemradio').find((o) => o.querySelector('.t')!.firstChild!.textContent === n)!.querySelector('.tag')?.textContent ?? null;
    expect(tagOf('kimi-k3')).toBe('effort: default');
    expect(tagOf('kimi-k3-max')).toBe('effort: max');
    expect(tagOf('codex-sol')).toBe('effort: xhigh');
    expect(tagOf('claude-opus')).toBeNull();
  });
});

describe('adding and copying a profile', () => {
  const catalog = [
    { agent: 'kimi-code', source: 'kimi', warning: '', models: [{ id: 'kimi-code/kimi-k3-1-pro', name: 'K3.1 Pro', description: '', main: true, efforts: ['low', 'high', 'max'], known: false }] },
    { agent: 'deepseek', source: 'builtin', warning: '', models: [{ id: 'deepseek-chat', name: 'Chat', description: '', main: true, efforts: [], known: false }] },
  ];
  const form = () => screen.getByTestId('profile-form');
  const pick = (testId: string, option: string) => {
    fireEvent.click(within(form()).getByTestId(testId));
    fireEvent.click(screen.getByRole('menuitemradio', { name: option }));
  };
  const nameField = () => within(form()).getByLabelText('Name') as HTMLInputElement;

  it('adds a catalog model: its levels, the import name with the effort, on, marked', async () => {
    const f = await openModels({ catalog });
    fireEvent.click(screen.getByTestId('add-model'));
    expect(form().textContent).toContain('A profile is a harness + model + effort that a task or agent is launched with.');
    pick('pf-harness', 'kimi-code');
    type(within(form()).getByLabelText('Model'), 'kimi-code/kimi-k3-1-pro');
    expect(nameField().value).toBe('kimi-k3-1-pro');
    pick('pf-effort', 'max');
    fireEvent.click(within(form()).getByTestId('pf-effort'));
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['default', 'low', 'high', 'max']);
    fireEvent.click(within(form()).getByTestId('pf-effort'));
    expect(nameField().value).toBe('kimi-k3-1-pro-max');
    type(within(form()).getByLabelText('Description'), 'Трудные места');
    fireEvent.click(within(form()).getByRole('button', { name: 'Add' }));
    await flush();
    expect(f.shell!.addProfile).toHaveBeenCalledWith({ name: undefined, agent: 'kimi-code', model: 'kimi-code/kimi-k3-1-pro', effort: 'max', description: 'Трудные места' });
    expect(screen.queryByTestId('profile-form')).toBeNull();
    expect(row('kimi-k3-1-pro-max').className).toContain('fresh');
    expect((within(row('kimi-k3-1-pro-max')).getByRole('switch') as HTMLElement).getAttribute('aria-checked')).toBe('true');
  });

  it('adds a model id the catalog does not list, with the harness levels', async () => {
    const f = await openModels({ catalog });
    fireEvent.click(screen.getByTestId('add-model'));
    type(within(form()).getByLabelText('Model'), 'claude-opus-5-6-preview');
    expect(form().textContent).toContain('Not in the catalog: used as written');
    fireEvent.click(within(form()).getByTestId('pf-effort'));
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'xhigh' }));
    type(nameField(), 'opus-preview');
    fireEvent.click(within(form()).getByRole('button', { name: 'Add' }));
    await flush();
    expect(f.shell!.addProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'opus-preview', agent: 'claude-code', model: 'claude-opus-5-6-preview', effort: 'xhigh' }));
    expect(row('opus-preview')).toBeTruthy();
  });

  it('a model without levels says so instead of offering them', async () => {
    await openModels({ catalog });
    fireEvent.click(screen.getByTestId('add-model'));
    pick('pf-harness', 'deepseek');
    type(within(form()).getByLabelText('Model'), 'deepseek-chat');
    expect(within(form()).queryByTestId('pf-effort')).toBeNull();
    expect(form().textContent).toContain('This model has no effort setting.');
  });

  it('a refusal shows next to its field', async () => {
    await openModels({ catalog });
    fireEvent.click(screen.getByTestId('add-model'));
    type(within(form()).getByLabelText('Model'), 'x');
    type(nameField(), 'claude-opus');
    fireEvent.click(within(form()).getByRole('button', { name: 'Add' }));
    await flush();
    const field = nameField().closest('.field') as HTMLElement;
    expect(within(field).getByRole('alert').textContent).toBe('A profile named claude-opus exists');
    expect(screen.getByTestId('profile-form')).toBeTruthy();
  });

  it('Copy… keeps harness and model, starts on Effort, and names it after the source', async () => {
    const profiles = [...PROFILES, makeProfile('kimi-k3-1-pro', { agent: 'kimi-code', model: 'kimi-code/kimi-k3-1-pro', description: 'Воркеры', position: 4 })];
    const f = await openModels({ catalog, profiles });
    await menu('kimi-k3-1-pro', 'Copy…');
    await flush();
    expect(form().getAttribute('aria-label')).toBe('Copy kimi-k3-1-pro');
    expect(within(form()).queryByLabelText('Model')).toBeNull();
    expect(form().textContent).toContain('kimi-code/kimi-k3-1-pro');
    expect(document.activeElement).toBe(within(form()).getByTestId('pf-effort'));
    expect(nameField().value).toBe('kimi-k3-1-pro-copy');
    pick('pf-effort', 'max');
    expect(nameField().value).toBe('kimi-k3-1-pro-max');
    expect((within(form()).getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Воркеры');
    fireEvent.click(within(form()).getByRole('button', { name: 'Copy' }));
    await flush();
    expect(f.shell!.copyProfile).toHaveBeenCalledWith('kimi-k3-1-pro', { name: undefined, effort: 'max', description: 'Воркеры' });
    expect(within(row('kimi-k3-1-pro-max')).getByTestId('effort-tag').textContent).toBe('effort: max');
  });
});
