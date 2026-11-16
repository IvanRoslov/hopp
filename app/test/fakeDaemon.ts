// FakeDaemon serves a small in-memory copy of the hopp API on a Unix socket
// in a temp directory. Unit and end-to-end tests use it instead of a real
// daemon; it never touches ~/.hopp.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ask, DaemonEvent, Session } from '../src/shared/types';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id, parent: '', dir: '/tmp/' + id, labels: {}, spawn_dirs: [], agent: 'claude',
    profile: 'test', model: 'm', effort: '', state: 'running', activity: 'ready',
    created_at: 1, updated_at: 1, ...over,
  };
}

export function makeAsk(id: number, from: string, over: Partial<Ask> = {}): Ask {
  return {
    id, from, labels: {}, body: 'question ' + id, options: [], attachments: [],
    status: 'open', created_at: 1, ...over,
  };
}

export class FakeDaemon {
  readonly home: string;
  readonly socketPath: string;
  sessions: Session[] = [];
  asks: Ask[] = [];
  events: DaemonEvent[] = [];
  requests: RecordedRequest[] = [];
  // attach maps a session id to the argv /attach returns; defaultAttach is
  // used for any other session.
  attach: Record<string, string[]> = {};
  defaultAttach: string[] = ['/bin/sh', '-c', 'echo hello; cat'];
  // override answers a "METHOD /path" with a fixed status and JSON body.
  override = new Map<string, { status: number; body: unknown }>();

  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private sse = new Set<ServerResponse>();
  private nextEventId = 1;

  constructor(home?: string) {
    this.home = home ?? mkdtempSync(join(tmpdir(), 'hopp-fake-'));
    this.socketPath = join(this.home, 'hopp.sock');
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => resolve());
    });
    this.server = server;
  }

  // stop closes the listener and drops every open connection, like a daemon
  // that exits. The socket file is removed.
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const r of this.sse) r.destroy();
    this.sse.clear();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.home, { recursive: true, force: true });
  }

  // publish appends an event to the log and writes it to every stream.
  publish(type: string, sessionId = '', data: Record<string, unknown> = {}): DaemonEvent {
    const e: DaemonEvent = { id: this.nextEventId++, ts: Math.floor(Date.now() / 1000), type, data };
    if (sessionId) e.session_id = sessionId;
    this.events.push(e);
    for (const r of this.sse) writeEvent(r, e);
    return e;
  }

  // writeRaw writes bytes to every open stream as they are, to test chunking.
  writeRaw(text: string): void {
    for (const r of this.sse) r.write(text);
  }

  // dropStreams closes every open event stream without stopping the daemon.
  dropStreams(): void {
    for (const r of this.sse) r.destroy();
    this.sse.clear();
  }

  get streamCount(): number {
    return this.sse.size;
  }

  setSession(s: Session): void {
    const i = this.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.sessions[i] = s;
    else this.sessions.push(s);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      try {
        this.route(req, res, body);
      } catch (err) {
        json(res, 500, { error: { code: 'internal_error', message: String(err) } });
      }
    });
  }

  private route(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', 'http://hopp');
    const path = url.pathname;
    const key = `${req.method} ${path}`;
    const o = this.override.get(key);
    if (o) return json(res, o.status, o.body);

    let m: RegExpMatchArray | null;
    if (key === 'GET /v1/health') {
      return json(res, 200, { status: 'ok', pid: 1, version: 'fake', started_at: 1 });
    }
    if (key === 'GET /v1/sessions') {
      const all = url.searchParams.get('all') === '1';
      const parent = url.searchParams.get('parent');
      let list = all ? this.sessions : this.sessions.filter((s) => s.state === 'spawning' || s.state === 'running');
      if (parent) list = list.filter((s) => s.parent === parent);
      return json(res, 200, { sessions: list });
    }
    if (req.method === 'GET' && (m = path.match(/^\/v1\/sessions\/([^/]+)\/attach$/))) {
      const id = decodeURIComponent(m[1]!);
      if (!this.sessions.some((s) => s.id === id)) return notFound(res, id);
      return json(res, 200, { command: this.attach[id] ?? this.defaultAttach });
    }
    if (req.method === 'POST' && (m = path.match(/^\/v1\/sessions\/([^/]+)\/quiz\/answer$/))) {
      const s = this.sessions.find((x) => x.id === decodeURIComponent(m![1]!));
      if (!s) return notFound(res, m[1]!);
      if (!s.question) return json(res, 409, { error: { code: 'no_pending_quiz', message: 'session has no pending quiz' } });
      JSON.parse(body);
      return json(res, 202, { status: 'answering' });
    }
    if (req.method === 'GET' && (m = path.match(/^\/v1\/sessions\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const s = this.sessions.find((x) => x.id === id);
      if (!s) return notFound(res, id);
      return json(res, 200, { ...s, children: this.sessions.filter((c) => c.parent === id).map((c) => c.id) });
    }
    if (key === 'GET /v1/asks') {
      const status = url.searchParams.get('status') ?? 'open';
      const from = url.searchParams.get('from');
      let list = status === 'all' ? this.asks : this.asks.filter((a) => a.status === status);
      if (from) list = list.filter((a) => a.from === from);
      return json(res, 200, { asks: list });
    }
    if (req.method === 'POST' && (m = path.match(/^\/v1\/asks\/(\d+)\/answer$/))) {
      const a = this.asks.find((x) => x.id === Number(m![1]));
      if (!a) return json(res, 404, { error: { code: 'ask_not_found', message: 'ask not found' } });
      if (a.status !== 'open') return json(res, 409, { error: { code: 'ask_closed', message: 'the ask is no longer open' } });
      const b = JSON.parse(body) as { choice?: string; answer?: string };
      a.status = 'answered';
      if (b.choice) a.choice = b.choice;
      if (b.answer) a.answer = b.answer;
      a.closed_at = 2;
      this.publish('ask.answered', a.from, { id: a.id });
      return json(res, 200, a);
    }
    if (key === 'GET /v1/waiting') {
      const live = this.sessions.filter((s) => s.state === 'spawning' || s.state === 'running');
      return json(res, 200, {
        asks: this.asks.filter((a) => a.status === 'open'),
        questions: live.filter((s) => s.question).map((s) => ({ session: s.id, question: s.question })),
      });
    }
    if (key === 'GET /v1/events/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.flushHeaders();
      const sinceRaw = url.searchParams.get('since') ?? req.headers['last-event-id'];
      if (typeof sinceRaw === 'string' && sinceRaw !== '') {
        const since = Number(sinceRaw);
        for (const e of this.events) if (e.id > since) writeEvent(res, e);
      }
      this.sse.add(res);
      res.on('close', () => this.sse.delete(res));
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'resource not found' } });
  }
}

function writeEvent(res: ServerResponse, e: DaemonEvent): void {
  res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

function notFound(res: ServerResponse, id: string): void {
  json(res, 404, { error: { code: 'session_not_found', message: 'session not found: ' + id } });
}
