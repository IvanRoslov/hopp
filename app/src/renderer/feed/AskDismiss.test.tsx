// Open asks in the feed: an answer in the human's own words, "Not relevant",
// and a line written while one question is open going as its answer.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, feedBridge, feedTask } from '../../../test/feedBridge';
import type { TaskFeed } from '../../shared/shell';
import { deriveStages } from '../../shared/stages';
import { PIPELINE } from '../../../test/feedBridge';
import { PipelineTaskView, type PipelinePanel } from './PipelineTaskView';

afterEach(cleanup);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function Host(props: { f: ReturnType<typeof feedBridge> }) {
  const [panel, setPanel] = useState<PipelinePanel | null>(null);
  return (
    <PipelineTaskView bridge={props.f.bridge} task={feedTask()} menu={<span />} terminal={<div />} details={<div />} panel={panel} onPanel={setPanel} />
  );
}

async function mount(feed: TaskFeed) {
  const f = feedBridge(feed);
  render(<Host f={f} />);
  await flush();
  return f;
}

const feedOf = (...asks: TaskFeed['asks']): TaskFeed => ({ posts: [], asks, artifacts: [] });

describe('an open question in the feed', () => {
  it('takes an answer in the human\'s own words when no option fits', async () => {
    const q = ask('Which colour?', { 'hopp.stage': 'script' }, { options: ['Red', 'Blue', 'Green'] });
    const f = await mount(feedOf(q));
    const block = screen.getByTestId(`ask-${q.id}`);
    fireEvent.click(within(block).getByTestId('ask-other'));
    fireEvent.change(within(block).getByLabelText('Your own answer'), { target: { value: 'Neither — keep the brand orange' } });
    await act(async () => fireEvent.click(within(block).getByRole('button', { name: 'Answer' })));
    expect(f.calls.answerAsk).toHaveBeenCalledWith(q.id, { answer: 'Neither — keep the brand orange' });
    await flush();
    const closed = document.querySelector(`[data-ask="${q.id}"]`)!;
    expect(closed.textContent).toContain('You answered: Neither — keep the brand orange');
  });

  it('is dismissed as not relevant after a one-line confirmation, and stays as a quiet line', async () => {
    const q = ask('Which colour?', {}, { options: ['Red', 'Blue'] });
    const f = await mount(feedOf(q));
    const block = screen.getByTestId(`ask-${q.id}`);
    fireEvent.click(within(block).getByTestId('ask-dismiss'));
    expect(within(block).getByText(/Close this question without an answer\?/)).toBeTruthy();
    expect(f.calls.dismissAsk).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(block).getByTestId('ask-dismiss-confirm')));
    expect(f.calls.dismissAsk).toHaveBeenCalledWith(q.id);
    await flush();
    expect(screen.queryByTestId(`ask-${q.id}`)).toBeNull();
    const line = document.querySelector(`[data-ask="${q.id}"]`)!;
    expect(line.textContent).toContain('Dismissed · not relevant');
    expect(line.textContent).not.toContain('You answered');
  });

  it('"Keep it" leaves the question open', async () => {
    const q = ask('Name?');
    const f = await mount(feedOf(q));
    const block = screen.getByTestId(`ask-${q.id}`);
    fireEvent.click(within(block).getByTestId('ask-dismiss'));
    fireEvent.click(within(block).getByRole('button', { name: 'Keep it' }));
    expect(within(block).getByTestId('ask-dismiss')).toBeTruthy();
    expect(f.calls.dismissAsk).not.toHaveBeenCalled();
  });

  it('a submission keeps Accept and Return only, and can be dismissed', async () => {
    const s = ask('Script is ready', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, { options: ['Accept', 'Return'] });
    const f = await mount(feedOf(s));
    const block = screen.getByTestId(`ask-${s.id}`);
    expect(within(block).queryByTestId('ask-other')).toBeNull();
    fireEvent.click(within(block).getByTestId('ask-dismiss'));
    await act(async () => fireEvent.click(within(block).getByTestId('ask-dismiss-confirm')));
    expect(f.calls.dismissAsk).toHaveBeenCalledWith(s.id);
  });

  it('a paid step gets Other… and Not relevant too', async () => {
    const p = ask('Render in 4K?', { 'hopp.kind': 'paid' }, { options: ['Go', 'Deny'] });
    await mount(feedOf(p));
    const block = screen.getByTestId(`ask-${p.id}`);
    expect(within(block).getByTestId('ask-other')).toBeTruthy();
    expect(within(block).getByTestId('ask-dismiss')).toBeTruthy();
  });
});

describe('writing to the orchestrator while one question is open', () => {
  it('offers to send the line as its answer, on by default', async () => {
    const q = ask('Which colour? Red, blue or green.', {}, { options: ['Red', 'Blue', 'Green'] });
    const f = await mount(feedOf(q));
    const box = screen.getByRole('checkbox');
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Send as the answer to: Which colour\?/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Write to the orchestrator'), { target: { value: 'Orange, as agreed' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(f.calls.answerAsk).toHaveBeenCalledWith(q.id, { answer: 'Orange, as agreed' });
    expect(f.calls.postToTask).not.toHaveBeenCalled();
  });

  it('unticked, the line is a plain message', async () => {
    const q = ask('Which colour?', {}, { options: ['Red', 'Blue'] });
    const f = await mount(feedOf(q));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Write to the orchestrator'), { target: { value: 'Unrelated note' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(f.calls.postToTask).toHaveBeenCalled();
    expect(f.calls.answerAsk).not.toHaveBeenCalled();
  });

  it('with two open questions, or only a submission, the line is a plain message', async () => {
    await mount(feedOf(ask('One?'), ask('Two?')));
    expect(screen.queryByRole('checkbox')).toBeNull();
    cleanup();
    await mount(feedOf(ask('Ready', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, { options: ['Accept', 'Return'] })));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('a dismissed submission', () => {
  it('puts its stage back to started, never accepted', () => {
    const sub = ask('Script is ready', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, {
      options: ['Accept', 'Return'], status: 'withdrawn', reason: 'dismissed', created_at: 10, closed_at: 20,
    });
    const st = deriveStages(PIPELINE, [], [sub]);
    expect(st[0]!.status).toBe('started');
    expect(st[0]!.submission).toBeNull();
  });
});
