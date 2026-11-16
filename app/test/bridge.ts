// A fake HoppBridge for renderer tests: an in-memory daemon plus hooks to
// push stream states and events.
import { vi } from 'vitest';
import type { HoppBridge } from '../src/shared/bridge';
import type { Ask, DaemonEvent, Session, StreamState } from '../src/shared/types';
import { fakeTerminalBridge } from './renderer';

export function fakeBridge(init: { sessions?: Session[]; asks?: Ask[]; state?: StreamState } = {}) {
  const stateCbs = new Set<(s: StreamState) => void>();
  const eventCbs = new Set<(e: DaemonEvent) => void>();
  const db = { sessions: init.sessions ?? [], asks: init.asks ?? [], state: init.state ?? ('open' as StreamState) };
  let eventId = 0;
  const daemon = {
    socketPath: vi.fn(async () => '/tmp/fake/hopp.sock'),
    streamState: vi.fn(async () => db.state),
    onStreamState: (cb: (s: StreamState) => void) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onEvent: (cb: (e: DaemonEvent) => void) => {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    listSessions: vi.fn(async (opts?: { all?: boolean }) =>
      opts?.all ? [...db.sessions] : db.sessions.filter((s) => s.state === 'running' || s.state === 'spawning'),
    ),
    getSession: vi.fn(async (id: string) => db.sessions.find((s) => s.id === id) ?? null),
    startDaemon: vi.fn(async () => ({ ok: true, message: 'started' })),
    listAsks: vi.fn(async (opts: { from?: string; status?: string } = {}) =>
      db.asks.filter((a) => (!opts.from || a.from === opts.from) && (opts.status === 'all' || a.status === (opts.status ?? 'open'))),
    ),
    answerAsk: vi.fn(async (id: number, body: { choice?: string; answer?: string }) => {
      const a = db.asks.find((x) => x.id === id)!;
      a.status = 'answered';
      Object.assign(a, body);
      return a;
    }),
    answerQuiz: vi.fn(async (_id: string, _body: unknown) => ({ status: 'answering' })),
  };
  const terminal = fakeTerminalBridge();
  const bridge: HoppBridge = { daemon, terminal };
  return {
    bridge,
    daemon,
    terminal,
    db,
    setState(s: StreamState) {
      db.state = s;
      stateCbs.forEach((cb) => cb(s));
    },
    emit(type: string, sessionId?: string, data: Record<string, unknown> = {}) {
      const e: DaemonEvent = { id: ++eventId, ts: 1, type, data };
      if (sessionId) e.session_id = sessionId;
      eventCbs.forEach((cb) => cb(e));
    },
  };
}
