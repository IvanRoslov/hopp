// Review Focus 4: a question arriving or the list updating while a terminal
// is open does not touch the terminal's size.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge } from '../../../test/bridge';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';
import { FakeFit, FakeResizeObserver, FakeXterm } from '../../../test/renderer';

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXterm }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { Workspace } = await import('../Workspace');

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  FakeXterm.instances = [];
  FakeResizeObserver.instances = [];
  FakeFit.next = { cols: 100, rows: 30 };
  (globalThis as any).ResizeObserver = FakeResizeObserver;
});
afterEach(cleanup);

describe('terminal size', () => {
  it('stays the same while questions arrive and the list updates', async () => {
    const f = fakeBridge({ sessions: [makeSession('a'), makeSession('b')] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getAllByTestId('session-row')[0]!);
    await flush();
    expect(f.terminal.open).toHaveBeenCalledTimes(1);
    const x = FakeXterm.instances[0]!;
    const before = { cols: x.cols, rows: x.rows };

    // A question arrives, an ask arrives, other rows change.
    f.db.sessions[0] = makeSession('a', {
      activity: 'waiting_input',
      question: { asked_at: 2, questions: [{ question: 'Q', header: 'H', multi_select: false, options: [{ label: 'o' }] }] },
    });
    f.emit('session.quiz_asked', 'a');
    f.db.asks.push(makeAsk(5, 'a'));
    f.emit('ask.created', 'a', { id: 5 });
    f.db.sessions[1] = makeSession('b', { activity: 'active' });
    f.emit('session.activity_changed', 'b');
    f.db.sessions.push(makeSession('c'));
    f.emit('session.spawned', 'c');
    await flush();
    expect(screen.getByTestId('questions-button').textContent).toBe('Questions · 2');

    expect(f.terminal.resize).not.toHaveBeenCalled();
    expect(f.terminal.close).not.toHaveBeenCalled();
    expect(f.terminal.open).toHaveBeenCalledTimes(1);
    expect(FakeXterm.instances).toHaveLength(1);
    expect({ cols: x.cols, rows: x.rows }).toEqual(before);
  });
});
