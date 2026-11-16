// EventStream follows the daemon's event stream (GET /v1/events/stream, SSE)
// and keeps following it: when the connection drops it reconnects with
// backoff and sends Last-Event-ID, so the daemon replays what was missed.
import { EventEmitter } from 'node:events';
import { request, type ClientRequest } from 'node:http';
import type { DaemonEvent, StreamState } from '../../shared/types';

export interface SSEMessage {
  id?: string;
  event?: string;
  data: string;
}

// SSEParser turns a byte stream into SSE messages. Chunks may split lines and
// messages anywhere; comment lines (": ping") are dropped.
export class SSEParser {
  private buf = '';
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];

  constructor(private readonly onMessage: (m: SSEMessage) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.search(/\r\n|\n|\r/);
      if (nl < 0) return;
      // A lone "\r" at the end of the buffer may be the start of "\r\n".
      if (this.buf[nl] === '\r' && nl === this.buf.length - 1) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(this.buf.startsWith('\r\n', nl) ? nl + 2 : nl + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onMessage({ id: this.id, event: this.event, data: this.data.join('\n') });
      this.id = undefined;
      this.event = undefined;
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') this.id = value;
    else if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

export interface EventStreamOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  // idleTimeoutMs: no bytes for this long (the daemon pings every 15 s)
  // means the connection is dead.
  idleTimeoutMs?: number;
  lastEventId?: number;
}

interface Events {
  event: [DaemonEvent];
  state: [StreamState];
}

export class EventStream extends EventEmitter<Events> {
  lastEventId: number | undefined;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly idleTimeoutMs: number;
  private running = false;
  private req: ClientRequest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private state: StreamState | null = null;

  constructor(
    readonly socketPath: string,
    opts: EventStreamOptions = {},
  ) {
    super();
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 45_000;
    this.lastEventId = opts.lastEventId;
  }

  get currentState(): StreamState | null {
    return this.state;
  }

  backoffFor(failures: number): number {
    return Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** failures);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const r = this.req;
    this.req = null;
    r?.destroy();
  }

  private setState(s: StreamState): void {
    if (this.state === s) return;
    // While down, retries do not flip the state back to "connecting": the
    // app stays in its "daemon is not running" view until a stream opens.
    if (this.state === 'down' && s === 'connecting') return;
    this.state = s;
    this.emit('state', s);
  }

  private connect(): void {
    if (!this.running) return;
    this.setState('connecting');
    const headers: Record<string, string> = { Host: 'hopp', Accept: 'text/event-stream' };
    if (this.lastEventId !== undefined) headers['Last-Event-ID'] = String(this.lastEventId);
    let ended = false;
    const fail = () => {
      if (ended) return;
      ended = true;
      if (this.req === req) this.req = null;
      if (!this.running) return;
      this.setState('down');
      const delay = this.backoffFor(this.failures++);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    const req = request({ socketPath: this.socketPath, path: '/v1/events/stream', method: 'GET', headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        res.on('end', fail);
        res.on('error', fail);
        return;
      }
      this.failures = 0;
      this.setState('open');
      res.setEncoding('utf8');
      const parser = new SSEParser((m) => this.message(m));
      res.on('data', (c: string) => parser.push(c));
      res.on('end', fail);
      res.on('error', fail);
      res.on('close', fail);
    });
    req.setTimeout(this.idleTimeoutMs, () => req.destroy(new Error('idle timeout')));
    req.on('error', fail);
    req.on('close', fail);
    this.req = req;
    req.end();
  }

  private message(m: SSEMessage): void {
    let e: DaemonEvent;
    try {
      e = JSON.parse(m.data) as DaemonEvent;
    } catch {
      return;
    }
    const id = m.id !== undefined ? Number(m.id) : e.id;
    if (Number.isFinite(id)) {
      // Never deliver an event twice, even if a replay overlaps.
      if (this.lastEventId !== undefined && id <= this.lastEventId) return;
      this.lastEventId = id;
    }
    if (m.event && !e.type) e.type = m.event;
    this.emit('event', e);
  }
}
