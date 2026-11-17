import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge, makeProfile, makeProject } from '../../../test/bridge';
import type { Pipeline } from '../../shared/shell';

vi.mock('../terminal/Terminal', () => ({ Terminal: () => <div data-testid="terminal" /> }));
const { ShellApp } = await import('./ShellApp');

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

const stage = (id: string, name: string, over = {}) => ({ id, name, does: name + ' does', result: name + ' result', substages: false, approval: true, ...over });
const video: Pipeline = {
  id: 'pv', name: 'Promo video', createdAt: 1, updatedAt: 1,
  stages: [stage('s1', 'Script'), stage('s2', 'Storyboard'), stage('s3', 'Scenes', { substages: true })],
};
const dev: Pipeline = { id: 'pd', name: 'Development', createdAt: 2, updatedAt: 2, stages: [stage('d1', 'Analyse')] };

async function mount(f: ReturnType<typeof fakeBridge>) {
  render(<ShellApp bridge={f.bridge} />);
  await flush();
  await flush();
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const seed = (pipelines: Pipeline[] = [video, dev]) =>
  fakeBridge({ shell: { state: { projects: [makeProject('p')], pipelines }, profiles: [makeProfile('opus')] } });
const stages = () => screen.getAllByTestId('pipeline-stage');
const stageNames = () => stages().map((s) => (within(s).getByLabelText('Stage name') as HTMLInputElement).value);

describe('pipelines editor', () => {
  it('lists pipelines and edits the chosen one: rename, move, flags, save', async () => {
    const f = seed();
    await mount(f);
    fireEvent.click(screen.getByText('Pipelines'));
    expect(screen.getAllByTestId('pipeline-row').map((r) => r.textContent)).toEqual(['Promo video', 'Development']);
    expect(stageNames()).toEqual(['Script', 'Storyboard', 'Scenes']);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(stages()[2]!).getByRole('button', { name: 'Move up' }));
    expect(stageNames()).toEqual(['Script', 'Scenes', 'Storyboard']);
    expect((within(stages()[0]!).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(stages()[0]!).getByRole('checkbox', { name: 'wait for approval' }));
    type(within(stages()[0]!).getByLabelText('What the stage does'), 'Write it');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    expect(f.shell!.updatePipeline).toHaveBeenCalledWith('pv', {
      name: 'Promo video',
      stages: [
        { id: 's1', name: 'Script', does: 'Write it', result: 'Script result', substages: false, approval: false },
        { id: 's3', name: 'Scenes', does: 'Scenes does', result: 'Scenes result', substages: true, approval: true },
        { id: 's2', name: 'Storyboard', does: 'Storyboard does', result: 'Storyboard result', substages: false, approval: true },
      ],
    });
  });

  it('creates a pipeline; an unnamed stage shows its error at that stage', async () => {
    const f = seed([]);
    await mount(f);
    fireEvent.click(screen.getByText('Pipelines'));
    type(screen.getByLabelText('Pipeline name'), 'Landing');
    type(within(stages()[0]!).getByLabelText('Stage name'), 'Questions');
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(within(stages()[1]!).getByRole('alert').textContent).toBe('Name every stage.');
    fireEvent.click(within(stages()[1]!).getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await flush();
    expect(f.shell!.createPipeline).toHaveBeenLastCalledWith({
      name: 'Landing',
      stages: [{ name: 'Questions', does: '', result: '', substages: false, approval: true }],
    });
    expect(screen.getAllByTestId('pipeline-row').map((r) => r.textContent)).toEqual(['Landing']);
  });

  it('keeps an unsaved draft while moving between pipelines', async () => {
    const f = seed();
    await mount(f);
    fireEvent.click(screen.getByText('Pipelines'));
    type(screen.getByLabelText('Pipeline name'), 'Promo video 2');
    fireEvent.click(screen.getAllByTestId('pipeline-row')[1]!);
    expect((screen.getByLabelText('Pipeline name') as HTMLInputElement).value).toBe('Development');
    expect(screen.getAllByTestId('pipeline-row')[0]!.textContent).toBe('Promo video•');
    fireEvent.click(screen.getAllByTestId('pipeline-row')[0]!);
    expect((screen.getByLabelText('Pipeline name') as HTMLInputElement).value).toBe('Promo video 2');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect((screen.getByLabelText('Pipeline name') as HTMLInputElement).value).toBe('Promo video');
  });

  it('deletes a pipeline after a confirmation', async () => {
    const f = seed();
    await mount(f);
    fireEvent.click(screen.getByText('Pipelines'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete pipeline' }));
    expect(screen.getByText('Delete Promo video? Running tasks keep their copy.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete pipeline' }));
    await flush();
    expect(f.shell!.removePipeline).toHaveBeenCalledWith('pv');
    expect(screen.getAllByTestId('pipeline-row').map((r) => r.textContent)).toEqual(['Development']);
  });
});

describe('pipeline picker in New task', () => {
  it('is "No pipeline" by default and launches without one', async () => {
    const f = seed();
    await mount(f);
    expect(screen.getByTestId('pick-pipeline').textContent).toBe('Pipeline: No pipeline');
    expect(screen.queryByTestId('pipeline-preview')).toBeNull();
    type(screen.getByLabelText('What needs to be done?'), 'Fix it');
    fireEvent.click(screen.getByRole('button', { name: 'Start the task' }));
    await flush();
    expect(f.shell!.createTask.mock.calls[0]![0]).not.toHaveProperty('pipelineId');
  });

  it('shows the stages before launch and launches with the pipeline', async () => {
    const f = seed();
    await mount(f);
    fireEvent.click(screen.getByTestId('pick-pipeline'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Promo video' }));
    const preview = screen.getByTestId('pipeline-preview');
    expect(preview.textContent).toContain('Script → Storyboard → Scenes');
    const flags = within(preview).getAllByRole('checkbox');
    expect(flags.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'true', 'true', 'true']);
    type(screen.getByLabelText('What needs to be done?'), 'A 30 s promo');
    fireEvent.click(screen.getByRole('button', { name: 'Start the task' }));
    await flush();
    expect(f.shell!.createTask).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'pv', brief: 'A 30 s promo' }));
  });

  // Ivan's own pipelines have stage texts of 2000 characters over many lines;
  // the preview showed them whole and the form became a long sheet.
  it('folds a long stage text to a few lines, with Show all', async () => {
    const long = 'Понять, чего хочет человек.\n' + '- Шаг с пояснением, достаточно длинный.\n'.repeat(12);
    const f = seed([{ ...dev, stages: [stage('d1', 'Analyse', { does: long }), stage('d2', 'Short')] }]);
    await mount(f);
    fireEvent.click(screen.getByTestId('pick-pipeline'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Development' }));
    const preview = screen.getByTestId('pipeline-preview');
    const [first, second] = Array.from(preview.querySelectorAll('.pl-preview-stage .ds'));
    expect(first!.classList.contains('folded')).toBe(true);
    expect(second!.classList.contains('folded')).toBe(false);
    expect(within(preview).getAllByRole('button', { name: 'Show all' })).toHaveLength(1);
    fireEvent.click(within(preview).getByRole('button', { name: 'Show all' }));
    expect(first!.classList.contains('folded')).toBe(false);
    fireEvent.click(within(preview).getByRole('button', { name: 'Show less' }));
    expect(first!.classList.contains('folded')).toBe(true);
  });
});
