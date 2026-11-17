import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonBridge } from '../../shared/bridge';
import type { Ask } from '../../shared/types';
import { QuestionsPanel } from './Panel';

afterEach(cleanup);

const mk = (id: number, over: Partial<Ask> = {}): Ask => ({
  id, from: 'cto', labels: {}, body: 'Which way?', options: ['Left', 'Right'], attachments: [], status: 'open', created_at: 1, ...over,
});

function mount(asks: Ask[]) {
  const daemon = {
    answerAsk: vi.fn(async (id: number) => mk(id, { status: 'answered' })),
    dismissAsk: vi.fn(async (id: number) => mk(id, { status: 'withdrawn', reason: 'dismissed' })),
    onEvent: () => () => {},
  } as unknown as DaemonBridge & { answerAsk: ReturnType<typeof vi.fn>; dismissAsk: ReturnType<typeof vi.fn> };
  const reloadAsks = vi.fn();
  render(<QuestionsPanel daemon={daemon} session={null} sessionId="cto" asks={asks} reloadAsks={reloadAsks} reloadSession={() => {}} />);
  return { daemon, reloadAsks };
}

describe('the Questions column', () => {
  it('answers in the human\'s own words', async () => {
    const { daemon } = mount([mk(4)]);
    const block = screen.getByTestId('ask-4');
    fireEvent.click(within(block).getByTestId('ask-other'));
    fireEvent.change(within(block).getByLabelText('Your own answer'), { target: { value: 'Straight on' } });
    await act(async () => fireEvent.click(within(block).getByRole('button', { name: 'Answer' })));
    expect(daemon.answerAsk).toHaveBeenCalledWith(4, { answer: 'Straight on' });
  });

  it('dismisses after confirming, and reloads', async () => {
    const { daemon, reloadAsks } = mount([mk(5, { options: [] })]);
    const block = screen.getByTestId('ask-5');
    fireEvent.click(within(block).getByTestId('ask-dismiss'));
    await act(async () => fireEvent.click(within(block).getByTestId('ask-dismiss-confirm')));
    expect(daemon.dismissAsk).toHaveBeenCalledWith(5);
    expect(reloadAsks).toHaveBeenCalled();
  });

  it('shows a dismissed ask as a quiet closed row', () => {
    mount([mk(6, { status: 'withdrawn', reason: 'dismissed', closed_at: 2 }), mk(7, { status: 'withdrawn', reason: 'superseded', closed_at: 3 })]);
    const rows = screen.getByTestId('answered').textContent ?? '';
    expect(rows).toContain('Which way? — Dismissed · not relevant');
    expect(rows).toContain('withdrawn (superseded)');
  });
});
