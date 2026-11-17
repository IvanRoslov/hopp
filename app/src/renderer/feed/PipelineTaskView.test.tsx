import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { art, ask, feedBridge, feedTask, post } from '../../../test/feedBridge';
import type { TaskFeed } from '../../shared/shell';
import { MARK_MS } from './Feed';
import { PipelineTaskView, type PipelinePanel } from './PipelineTaskView';

afterEach(cleanup);

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function Host(props: { f: ReturnType<typeof feedBridge>; panel?: PipelinePanel | null; focusAskId?: number; finished?: boolean }) {
  const [panel, setPanel] = useState<PipelinePanel | null>(props.panel ?? null);
  return (
    <PipelineTaskView
      bridge={props.f.bridge}
      task={feedTask(props.finished ? { status: 'finished' } : {})}
      menu={<button type="button">···</button>}
      terminal={<div data-testid="term-slot">terminal here</div>}
      details={<div>details here</div>}
      status={props.finished ? 'Finished.' : undefined}
      panel={panel}
      onPanel={setPanel}
      focusAskId={props.focusAskId}
    />
  );
}

const scene1 = art('scene-1', 2, { labels: { 'hopp.task': 'promo', 'hopp.stage': 'scenes', 'hopp.substage': 's1' } });
const scene2v1 = art('scene-2', 1, { labels: { 'hopp.task': 'promo', 'hopp.stage': 'scenes', 'hopp.substage': 's2' } });
const scene2 = art('scene-2', 2, { labels: { 'hopp.task': 'promo', 'hopp.stage': 'scenes', 'hopp.substage': 's2' } });
const script = art('script', 1, { mime: 'text/markdown', filename: 'script.md', labels: { 'hopp.task': 'promo', 'hopp.stage': 'script' } });

function sample(): TaskFeed {
  return {
    posts: [
      post('Starting the script', { 'hopp.stage': 'script', 'hopp.event': 'stage_started' }, { created_at: 300 }),
      post('Warmer light in scene 2.', { 'hopp.stage': 'scenes', 'hopp.substage': 's2', 'hopp.substage_title': 'Scene 2', 'hopp.event': 'stage_started' }, { created_at: 400, attachments: ['scene-2@2'] }),
    ],
    asks: [
      ask('Script is ready', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, { created_at: 350, status: 'answered', choice: 'Accept', closed_at: 360, options: ['Accept', 'Return'] }),
      ask('How warm?', { 'hopp.stage': 'scenes', 'hopp.substage': 's2' }, { created_at: 410, status: 'answered', choice: 'Warmer', closed_at: 420, options: ['Warmer', 'Same'] }),
      ask('Stage «Scenes» is ready', { 'hopp.stage': 'scenes', 'hopp.kind': 'submission' }, { created_at: 500, options: ['Accept', 'Return'], attachments: ['scene-1@2', 'scene-2@2', 'notes.txt'] }),
      ask('Render in 4K? It costs 3 credits.', { 'hopp.stage': 'scenes', 'hopp.kind': 'paid' }, { created_at: 510, options: ['Go', 'Deny'] }),
    ],
    artifacts: [script, scene1, scene2v1, scene2],
  };
}

async function mount(props: Partial<Parameters<typeof Host>[0]> = {}, feed = sample()) {
  const f = feedBridge(feed);
  render(<Host f={f} {...props} />);
  await flush();
  return f;
}

// quiet: the text of the answered entries, question and answer line.
const quiet = () => [...document.querySelectorAll('.entry-quiet')].map((e) => e.textContent ?? '');

describe('PipelineTaskView feed', () => {
  it('shows the brief, posts with author, time and stage tag, artifact tiles, and quiet answered lines', async () => {
    await mount();
    expect(screen.getByText('Make a promo video from the brief.')).toBeTruthy();
    expect(screen.getAllByText('Orchestrator').length).toBeGreaterThan(0);
    // The post declares the substage's title; the ask with the slug alone shows it too.
    expect(screen.getAllByText('Scenes · Scene 2', { selector: '.entry-meta span' })).toHaveLength(2);
    expect(screen.getAllByTestId('artifact-tile-scene-2@2').length).toBeGreaterThan(0);
    expect(quiet()).toContain('How warm?You answered: Warmer');
    expect(quiet()).toContain('Script is readyYou answered: Accept');
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });

  it('accepts a submission', async () => {
    const f = await mount();
    const block = screen.getByText('Stage «Scenes» is ready').closest('article')!;
    fireEvent.click(within(block as HTMLElement).getByRole('button', { name: 'Accept' }));
    await flush();
    expect(f.calls.answerSubmission).toHaveBeenCalledWith(expect.any(Number), { choice: 'Accept' });
    expect(quiet()).toContain('Stage «Scenes» is readyYou answered: Accept');
  });

  it('returns a submission only with what to fix', async () => {
    const f = await mount();
    const block = screen.getByText('Stage «Scenes» is ready').closest('article') as HTMLElement;
    fireEvent.click(within(block).getByRole('button', { name: 'Return' }));
    const send = within(block).getByRole('button', { name: 'Return' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(block).getByLabelText('What should be fixed?'), { target: { value: 'Scene 1 is too dark' } });
    fireEvent.click(send);
    await flush();
    expect(f.calls.answerSubmission).toHaveBeenCalledWith(expect.any(Number), { choice: 'Return', text: 'Scene 1 is too dark' });
  });

  it('answers a paid ask with Go through the daemon', async () => {
    const f = await mount();
    const block = screen.getByText('Render in 4K? It costs 3 credits.').closest('article') as HTMLElement;
    const go = within(block).getByRole('button', { name: 'Go' });
    expect(go.className).toContain('primary');
    fireEvent.click(go);
    await flush();
    expect(f.calls.answerAsk).toHaveBeenCalledWith(expect.any(Number), { choice: 'Go' });
  });

  it('writes to the orchestrator with Enter, tagged with the filtered stage', async () => {
    const f = await mount();
    const box = screen.getByLabelText('Write to the orchestrator');
    fireEvent.change(box, { target: { value: 'Use the blue logo' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(f.calls.postToTask).toHaveBeenCalledWith('promo', 'Use the blue logo', undefined);
    expect((box as HTMLTextAreaElement).value).toBe('');
    f.state.postFails = 'The orchestrator is not running; resume the task to write to it';
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('not running');
    expect((box as HTMLTextAreaElement).value).toBe('again');
  });

  it('filters the feed by stage', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('feed-filter'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Script/ }));
    await flush();
    expect(screen.queryByText('Make a promo video from the brief.')).toBeNull();
    expect(screen.getByText('Starting the script')).toBeTruthy();
    expect(screen.queryByText('Warmer light in scene 2.')).toBeNull();
  });

  it('reloads when the main process says this task\'s feed changed', async () => {
    const f = await mount();
    f.state.feed.posts.push(post('A new note', {}, { created_at: 900 }));
    f.emit('other');
    await flush();
    expect(screen.queryByText('A new note')).toBeNull();
    f.emit('promo');
    await flush();
    expect(screen.getByText('A new note')).toBeTruthy();
  });

  it('a finished task shows its status and the input is closed', async () => {
    await mount({ finished: true });
    expect(screen.getByText('Finished.')).toBeTruthy();
    expect((screen.getByLabelText('Write to the orchestrator') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('PipelineTaskView panels', () => {
  it('Stages shows each stage with its derived state and counts what waits', async () => {
    await mount();
    expect(screen.getByTestId('stages-button').textContent).toBe('Stages · 1');
    fireEvent.click(screen.getByTestId('stages-button'));
    const panel = screen.getByTestId('stages-panel');
    expect(within(within(panel).getByTestId('stage-script')).getByText('accepted')).toBeTruthy();
    expect(within(within(panel).getByTestId('stage-scenes')).getByText('waiting for you')).toBeTruthy();
    expect(within(within(panel).getByTestId('stage-assembly')).getByText('not started')).toBeTruthy();
    // the waiting stage is open with its substages and the submission link
    expect(within(panel).getByText('Scene 2')).toBeTruthy();
    expect(within(panel).getByText('Submitted · waiting for approval')).toBeTruthy();
    fireEvent.click(within(panel).getByText('Collapse all'));
    expect(within(panel).queryByText('Scene 2')).toBeNull();
    expect(within(panel).getByText('Expand all')).toBeTruthy();
  });

  it('the submission link marks the submission in the feed', async () => {
    await mount({ panel: 'stages' });
    fireEvent.click(screen.getByText('Submitted · waiting for approval'));
    await flush();
    expect(screen.getByText('Stage «Scenes» is ready').closest('article')!.className).toContain('marked');
  });

  it('Artifacts shows the latest version of each name, searches and filters by stage', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('artifacts-button'));
    const panel = screen.getByTestId('artifacts-panel');
    expect(within(panel).getByTestId('artifact-tile-scene-2@2').textContent).toContain('Image · version 2 · submitted');
    expect(within(panel).queryByTestId('artifact-tile-scene-2@1')).toBeNull();
    expect(within(panel).getByTestId('artifact-tile-script@1').textContent).toContain('Text · version 1');
    fireEvent.change(within(panel).getByLabelText('Find an artifact'), { target: { value: 'scene-1' } });
    expect(within(panel).queryByTestId('artifact-tile-script@1')).toBeNull();
    expect(within(panel).getByTestId('artifact-tile-scene-1@2')).toBeTruthy();
    expect(within(panel).getByText('Open the submission and decide')).toBeTruthy();
  });

  it('All artifacts from a submission opens the panel filtered to its stage', async () => {
    await mount();
    const block = screen.getByText('Stage «Scenes» is ready').closest('article') as HTMLElement;
    fireEvent.click(within(block).getByRole('button', { name: 'All artifacts' }));
    const panel = screen.getByTestId('artifacts-panel');
    expect(within(panel).getByTestId('artifacts-stage').textContent).toContain('Scenes');
    expect(within(panel).queryByTestId('artifact-tile-script@1')).toBeNull();
  });

  it('a tile in the feed opens the viewer with a version picker and compare', async () => {
    await mount();
    fireEvent.click(screen.getAllByTestId('artifact-tile-scene-2@2')[0]!);
    const viewer = screen.getByTestId('artifact-viewer');
    expect(within(viewer).getByTestId('version-picker').textContent).toContain('Version 2 · submitted');
    const img = viewer.querySelector('img.viewer-img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`hopp-artifact://${scene2.id}`);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Compare' }));
    expect(viewer.querySelectorAll('img.viewer-img')).toHaveLength(2);
    expect(within(viewer).getByTestId('compare-picker').textContent).toContain('Version 1');
    fireEvent.click(within(viewer).getByRole('button', { name: 'All artifacts' }));
    expect(screen.getByTestId('artifacts-panel')).toBeTruthy();
  });

  it('a text artifact is read through the bridge', async () => {
    const f = await mount({ panel: 'artifacts' });
    fireEvent.click(screen.getByTestId('artifact-tile-script@1'));
    await flush();
    expect(f.calls.artifactText).toHaveBeenCalledWith(script.id);
    expect(screen.getByText(`text of ${script.id}`)).toBeTruthy();
  });

  it('Terminal and Details show the slots they are given; the close button closes', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('terminal-button'));
    expect(screen.getByTestId('term-slot')).toBeTruthy();
    expect(screen.getByTestId('terminal-button').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByLabelText('Close the column'));
    expect(screen.queryByTestId('pipeline-panel')).toBeNull();
  });

  it('a feed that fails to load says so and offers Retry', async () => {
    const f = feedBridge(sample());
    f.calls.taskFeed.mockRejectedValueOnce(new Error('daemon down'));
    render(<Host f={f} />);
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('daemon down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('markdown in the feed', () => {
  it('post and ask bodies and a "what to fix" answer render as compact markdown', async () => {
    const feed = sample();
    feed.posts.push(post('## План\n\n- шаг **один**\n- шаг `два`\n\nСм. [сценарий](script@1).', { 'hopp.stage': 'script' }, { created_at: 600 }));
    feed.asks.push(
      ask('Готово?', { 'hopp.stage': 'script', 'hopp.kind': 'submission' }, {
        created_at: 610, status: 'answered', choice: 'Return', answer: 'Исправить:\n- титры **крупнее**', closed_at: 620, options: ['Accept', 'Return'],
      }),
    );
    await mount({}, feed);
    const body = [...document.querySelectorAll('.entry-body.md-compact')].find((b) => b.querySelector('h2'))!;
    expect(body.querySelector('h2')!.textContent).toBe('План');
    expect(body.querySelector('li strong')!.textContent).toBe('один');
    expect(body.querySelector('li code')!.textContent).toBe('два');
    // A link naming an artifact of the task opens it in the viewer.
    fireEvent.click(within(body as HTMLElement).getByRole('button', { name: 'сценарий' }));
    await flush();
    expect(screen.getByTestId('artifact-viewer')).toBeTruthy();
    const answer = [...document.querySelectorAll('.entry-answer')].find((a) => a.textContent!.includes('Исправить'))!;
    expect(answer.textContent).toContain('You answered: Return — ');
    expect(answer.querySelector('li strong')!.textContent).toBe('крупнее');
  });
});

describe('the question a jump leads to', () => {
  it('is tinted once, as one layer, and the tint goes after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const feed = sample();
      const paid = feed.asks.find((a) => a.labels?.['hopp.kind'] === 'paid')!;
      await mount({ focusAskId: paid.id }, feed);
      const block = document.querySelector(`[data-ask="${paid.id}"]`)!;
      expect(block.className).toContain('marked');
      act(() => {
        vi.advanceTimersByTime(MARK_MS);
      });
      expect(block.className).not.toContain('marked');
    } finally {
      vi.useRealTimers();
    }
  });
});
