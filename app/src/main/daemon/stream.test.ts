import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon } from '../../../test/fakeDaemon';
import type { DaemonEvent, StreamState } from '../../shared/types';
import { EventStream, SSEParser } from './stream';

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SSEParser', () => {
  it('parses events split across chunks and ignores comments', () => {
    const got: { id?: string; event?: string; data: string }[] = [];
    const p = new SSEParser((m) => got.push(m));
    p.push(': ping\n\nid: 7\nev');
    p.push('ent: session.state_changed\nda');
    p.push('ta: {"a":1}\n');
    expect(got).toHaveLength(0);
    p.push('\n: ping\n\n');
    p.push('id: 8\r\ndata: x\r\ndata: y\r\n\r\n');
    expect(got).toEqual([
      { id: '7', event: 'session.state_changed', data: '{"a":1}' },
      { id: '8', event: undefined, data: 'x\ny' },
    ]);
  });
});

describe('EventStream', () => {
  let d: FakeDaemon;
  let s: EventStream;
  let events: DaemonEvent[];
  let states: StreamState[];

  beforeEach(async () => {
    d = new FakeDaemon();
    await d.start();
    events = [];
    states = [];
    s = new EventStream(d.socketPath, { initialBackoffMs: 20, maxBackoffMs: 100 });
    s.on('event', (e) => events.push(e));
    s.on('state', (st) => states.push(st));
  });
  afterEach(async () => {
    s.stop();
    await d.dispose();
  });

  it('delivers events and ignores heartbeats', async () => {
    s.start();
    await until(() => d.streamCount === 1);
    expect(states).toEqual(['connecting', 'open']);
    d.publish('session.spawned', 'a', { x: 1 });
    d.writeRaw(': ping\n\n');
    d.publish('session.state_changed', 'a');
    await until(() => events.length === 2);
    expect(events.map((e) => [e.id, e.type, e.session_id])).toEqual([
      [1, 'session.spawned', 'a'],
      [2, 'session.state_changed', 'a'],
    ]);
    expect(s.lastEventId).toBe(2);
  });

  it('reconnects with Last-Event-ID after a drop, without duplicates or gaps', async () => {
    s.start();
    await until(() => d.streamCount === 1);
    d.publish('e1');
    d.publish('e2');
    await until(() => events.length === 2);
    d.dropStreams();
    // Published while the app is disconnected: must arrive by catch-up.
    d.publish('e3');
    d.publish('e4');
    await until(() => events.length === 4);
    const streamReqs = d.requests.filter((r) => r.url.startsWith('/v1/events/stream'));
    expect(streamReqs).toHaveLength(2);
    expect(streamReqs[0]!.headers['last-event-id']).toBeUndefined();
    expect(streamReqs[1]!.headers['last-event-id']).toBe('2');
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(states).toEqual(['connecting', 'open', 'down', 'open']);
  });

  it('goes down while the daemon is stopped and open when it is back', async () => {
    s.start();
    await until(() => states.includes('open'));
    await d.stop();
    await until(() => states.includes('down'));
    // Several failed attempts while the daemon is away.
    await new Promise((r) => setTimeout(r, 150));
    expect(states.filter((x) => x === 'open')).toHaveLength(1);
    await d.start();
    await until(() => states.filter((x) => x === 'open').length === 2);
    expect(states.at(-1)).toBe('open');
    // "down" is reported once per outage, not once per failed attempt.
    expect(states.filter((x) => x === 'down')).toHaveLength(1);
  });

  it('starts down when there is no daemon, and stop ends retries', async () => {
    await d.stop();
    s.start();
    await until(() => states.includes('down'));
    s.stop();
    const n = states.length;
    await d.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(states.length).toBe(n);
    expect(d.streamCount).toBe(0);
  });

  it('backoff doubles from the initial delay up to the cap', () => {
    const b = new EventStream('/x', { initialBackoffMs: 500, maxBackoffMs: 5000 });
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => b.backoffFor(n))).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });
});
