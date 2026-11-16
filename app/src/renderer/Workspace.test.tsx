import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBridge } from '../../test/bridge';
import { makeSession } from '../../test/fakeDaemon';

// The terminal itself is tested on its own; here it is a marker.
const mounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('./terminal/Terminal', async () => {
  const { useEffect } = await import('react');
  return {
    Terminal: (p: { sessionId: string }) => {
      useEffect(() => {
        mounts.n++;
      }, []);
      return <div data-testid="terminal">terminal:{p.sessionId}</div>;
    },
  };
});

const { Workspace } = await import('./Workspace');

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(cleanup);

describe('<Workspace>', () => {
  it('renders the session tree with state words', async () => {
    const f = fakeBridge({
      sessions: [
        makeSession('parent', { activity: 'active' }),
        makeSession('child', { parent: 'parent', activity: 'waiting_input' }),
        makeSession('ended', { state: 'done' }),
      ],
    });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    const rows = screen.getAllByTestId('session-row');
    expect(rows.map((r) => r.textContent)).toEqual(['parentworking', 'childwaiting for input']);
    expect(rows[1]!.getAttribute('data-depth')).toBe('1');
    fireEvent.click(screen.getByLabelText('Show ended'));
    expect(screen.getAllByTestId('session-row').map((r) => r.dataset['id'])).toEqual(['ended', 'parent', 'child']);
  });

  it('an event updates a row', async () => {
    const f = fakeBridge({ sessions: [makeSession('a', { activity: 'ready' })] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    expect(screen.getByTestId('session-row').textContent).toBe('aidle');
    f.db.sessions[0] = makeSession('a', { activity: 'active' });
    f.emit('session.activity_changed', 'a');
    await flush();
    expect(screen.getByTestId('session-row').textContent).toBe('aworking');
    // A new session appears; a removed one goes.
    f.db.sessions.push(makeSession('b'));
    f.emit('session.spawned', 'b');
    await flush();
    expect(screen.getAllByTestId('session-row')).toHaveLength(2);
    f.db.sessions = f.db.sessions.filter((s) => s.id !== 'a');
    f.emit('session.removed', 'a');
    await flush();
    expect(screen.getAllByTestId('session-row').map((r) => r.dataset['id'])).toEqual(['b']);
  });

  it('selecting a session shows its terminal on the right', async () => {
    const f = fakeBridge({ sessions: [makeSession('a'), makeSession('b')] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    expect(screen.queryByTestId('terminal')).toBeNull();
    fireEvent.click(screen.getAllByTestId('session-row')[1]!);
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:b');
  });

  it('a selected session that ends stays selected and shows as exited', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getByTestId('session-row'));
    f.db.sessions[0] = makeSession('a', { state: 'killed' });
    f.emit('session.killed', 'a');
    await flush();
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:a');
    expect(screen.getByTestId('selected-state').textContent).toBe('exited');
  });

  it('daemon down shows the state screen; back up reloads the list', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    expect(f.daemon.listSessions).toHaveBeenCalledTimes(1);
    act(() => f.setState('down'));
    expect(screen.getByText(/daemon is not running/i)).toBeTruthy();
    expect(await screen.findByText(/\/tmp\/fake\/hopp\.sock/)).toBeTruthy();
    expect(screen.queryByTestId('session-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start daemon' }));
    await flush();
    expect(f.daemon.startDaemon).toHaveBeenCalled();
    f.db.sessions.push(makeSession('b'));
    act(() => f.setState('open'));
    await flush();
    expect(f.daemon.listSessions).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId('session-row')).toHaveLength(2);
  });

  it('says when hopp cannot be started', async () => {
    const f = fakeBridge({ state: 'down' });
    f.daemon.startDaemon.mockResolvedValueOnce({ ok: false, message: 'hopp was not found on PATH' });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Start daemon' }));
    await flush();
    expect(screen.getByText('hopp was not found on PATH')).toBeTruthy();
  });

  it('a daemon outage keeps the open terminal mounted', async () => {
    const f = fakeBridge({ sessions: [makeSession('a')] });
    render(<Workspace bridge={f.bridge} />);
    await flush();
    fireEvent.click(screen.getByTestId('session-row'));
    await flush();
    const before = mounts.n;
    act(() => f.setState('down'));
    await flush();
    expect(screen.getByTestId('daemon-down')).toBeTruthy();
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:a');
    act(() => f.setState('open'));
    await flush();
    expect(screen.getByTestId('terminal').textContent).toBe('terminal:a');
    expect(mounts.n).toBe(before);
  });
});
