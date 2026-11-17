// A submission with the orchestrator's own options: every option is a button
// that sends its exact text; the first Accept variant is the primary one.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, feedBridge, feedTask } from '../../../test/feedBridge';
import type { TaskFeed } from '../../shared/shell';
import { PipelineTaskView, type PipelinePanel } from './PipelineTaskView';

afterEach(cleanup);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function Host(props: { f: ReturnType<typeof feedBridge> }) {
  const [panel, setPanel] = useState<PipelinePanel | null>(null);
  return <PipelineTaskView bridge={props.f.bridge} task={feedTask()} menu={<span />} terminal={<div />} details={<div />} panel={panel} onPanel={setPanel} />;
}
async function mount(...asks: TaskFeed['asks']) {
  const f = feedBridge({ posts: [], asks, artifacts: [] });
  render(<Host f={f} />);
  await flush();
  return f;
}

const IVAN = ['Accept: открыть PR и влить все три (app, toolkit-fix, vault)', 'Accept: только открыть PR, сливаю сам', 'Accept: оставить ветки как есть', 'Return'];
const sub = (options: string[] | null) => ask('Этап «Проверка» готов', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, { options });

describe('a submission with its own options', () => {
  it('draws every option with its full text, the first Accept variant primary', async () => {
    const s = sub(IVAN);
    await mount(s);
    const block = screen.getByTestId(`ask-${s.id}`);
    for (const o of IVAN) expect(within(block).getByRole('button', { name: o })).toBeTruthy();
    expect(within(block).getByRole('button', { name: IVAN[0]! }).className).toContain('primary');
    for (const o of IVAN.slice(1)) expect(within(block).getByRole('button', { name: o }).className).not.toContain('primary');
    expect(within(block).queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  for (const choice of IVAN.slice(0, 3)) {
    it(`"${choice}" answers with its exact text`, async () => {
      const s = sub(IVAN);
      const f = await mount(s);
      await act(async () => fireEvent.click(within(screen.getByTestId(`ask-${s.id}`)).getByRole('button', { name: choice })));
      expect(f.calls.answerSubmission).toHaveBeenCalledWith(s.id, { choice });
    });
  }

  it('Return asks what should be fixed, then sends it', async () => {
    const s = sub(IVAN);
    const f = await mount(s);
    const block = screen.getByTestId(`ask-${s.id}`);
    fireEvent.click(within(block).getByRole('button', { name: 'Return' }));
    fireEvent.change(within(block).getByLabelText('What should be fixed?'), { target: { value: 'Сначала тесты' } });
    await act(async () => fireEvent.click(within(block).getByRole('button', { name: 'Return' })));
    expect(f.calls.answerSubmission).toHaveBeenCalledWith(s.id, { choice: 'Return', text: 'Сначала тесты' });
  });

  it('the plain two-option submission is unchanged', async () => {
    const s = sub(['Accept', 'Return']);
    const f = await mount(s);
    const block = screen.getByTestId(`ask-${s.id}`);
    expect(within(block).getByRole('button', { name: 'Accept' }).className).toContain('primary');
    expect(within(block).queryByTestId('ask-other')).toBeNull();
    await act(async () => fireEvent.click(within(block).getByRole('button', { name: 'Accept' })));
    expect(f.calls.answerSubmission).toHaveBeenCalledWith(s.id, { choice: 'Accept' });
  });

  it('with no options, or none that accepts, it is an ordinary question: no button that cannot work', async () => {
    const none = sub([]);
    const odd = sub(['Merge', 'Wait']);
    const f = await mount(none, odd);
    const b1 = screen.getByTestId(`ask-${none.id}`);
    expect(within(b1).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(b1).getByLabelText('Your answer')).toBeTruthy();
    const b2 = screen.getByTestId(`ask-${odd.id}`);
    expect(within(b2).getByTestId('ask-other')).toBeTruthy();
    await act(async () => fireEvent.click(within(b2).getByRole('button', { name: 'Merge' })));
    expect(f.calls.answerAsk).toHaveBeenCalledWith(odd.id, { choice: 'Merge' });
    expect(f.calls.answerSubmission).not.toHaveBeenCalled();
  });
});
