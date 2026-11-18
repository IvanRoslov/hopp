// Attachments in a task's feed: the line to the orchestrator takes files and
// folders, and the Attached block of what the human sent shows as chips.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, feedBridge, feedTask, post } from '../../../test/feedBridge';
import type { TaskFeed } from '../../shared/shell';
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

describe('attachments in the feed', () => {
  it('sends attached paths with the line, and attachments alone', async () => {
    const f = await mount({ posts: [], asks: [], artifacts: [] });
    f.state.paths = { '/Users/me/log.txt': 'file', '/Users/me/out': 'dir' };
    f.state.picks = [['/Users/me/log.txt', '/Users/me/out'], ['/Users/me/log.txt']];
    const composer = screen.getByLabelText('Write to the orchestrator').closest('.composer') as HTMLElement;
    fireEvent.click(within(composer).getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Write to the orchestrator'), { target: { value: 'See the log' } });
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    await flush();
    expect(f.calls.postToTask).toHaveBeenLastCalledWith('promo', 'See the log\n\nAttached:\n- /Users/me/log.txt\n- /Users/me/out/', undefined);
    // Sent: the field and its chips are empty again.
    expect(within(composer).queryByTestId('attachments')).toBeNull();
    fireEvent.click(within(composer).getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    await flush();
    expect(f.calls.postToTask).toHaveBeenLastCalledWith('promo', 'Attached:\n- /Users/me/log.txt', undefined);
  });

  it('goes as the answer to the one open question, attachments included', async () => {
    const q = ask('Which logo?');
    const f = await mount({ posts: [], asks: [q], artifacts: [] });
    f.state.paths = { '/Users/me/logo.svg': 'file' };
    f.state.picks = [['/Users/me/logo.svg']];
    const composer = screen.getByLabelText('Write to the orchestrator').closest('.composer') as HTMLElement;
    fireEvent.click(within(composer).getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }));
    await flush();
    expect(f.calls.answerAsk).toHaveBeenCalledWith(q.id, { answer: 'Attached:\n- /Users/me/logo.svg' });
  });

  it('draws the Attached block of the human\'s line as chips that open the file', async () => {
    const mine = post('Look at this\n\nAttached:\n- /Users/me/shot.png\n- /Users/me/src/', {}, { from: '' });
    // An agent's post with the same text is the agent's words: left as text.
    const theirs = post('Attached:\n- /x/y.txt', {}, { from: 'orch' });
    const f = await mount({ posts: [mine, theirs], asks: [], artifacts: [] });
    const lists = screen.getAllByTestId('attached');
    expect(lists).toHaveLength(1);
    expect(screen.queryByText(/Attached:\s*- \/Users/)).toBeNull();
    expect(screen.getByText('Look at this')).toBeTruthy();
    const chips = Array.from(lists[0]!.querySelectorAll('.att-chip')).map((c) => c.textContent);
    expect(chips).toEqual(['shot.png', 'src']);
    fireEvent.click(within(lists[0]!).getByRole('button', { name: /shot\.png/ }));
    await flush();
    expect(f.calls.openAttachment).toHaveBeenCalledWith('/Users/me/shot.png', false);
  });
});
