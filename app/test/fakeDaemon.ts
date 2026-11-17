// FakeDaemon serves a small in-memory copy of the hopp API on a Unix socket
// in a temp directory. Unit and end-to-end tests use it instead of a real
// daemon; it never touches ~/.hopp.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Lesson, ModelProfile, Post } from '../src/shared/shell';
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

export function makeProfile(name: string, over: Partial<ModelProfile> = {}): ModelProfile {
  return { name, agent: 'claude-code', model: 'm', effort: '', description: '', enabled: true, position: 0, ...over };
}

export function makeLesson(id: number, over: Partial<Lesson> = {}): Lesson {
  return { id, from: '', labels: {}, body: 'lesson ' + id, status: 'new', created_at: 1, closed_at: 0, ...over };
}

const LIVE = new Set(['spawning', 'running']);

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
  profiles: ModelProfile[] = [];
  defaultProfile: string | undefined;
  catalogs: { agent: string; source: string; warning: string; models: { id: string; name: string; description: string; main: boolean; efforts: string[] }[] }[] = [];
  posts: Post[] = [];
  artifacts: (Artifact & { path: string })[] = [];
  messages: { id: number; from?: string; to: string; body: string }[] = [];
  mailboxes: { name: string; unread: number; total: number }[] = [];
  // Live tmux sessions outside hopp: a launch with one of these ids is
  // refused as taken, and /v1/session-ids names tmux as the holder.
  foreignTmux: string[] = [];
  lessons: Lesson[] = [];
  // created records every POST /v1/sessions body, in order.
  created: Record<string, unknown>[] = [];
  // delay holds the answer to a "METHOD /path" this many ms after the
  // request was handled (the change is made at once, as a slow daemon would).
  delay = new Map<string, number>();
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
      const url = new URL(req.url ?? '/', 'http://hopp');
      const wait = this.delay.get(`${req.method} ${url.pathname}`);
      if (wait) (res as ServerResponse & { hoppDelay?: number }).hoppDelay = wait;
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
    if (key === 'POST /v1/sessions') {
      const b = JSON.parse(body || '{}') as Record<string, unknown>;
      this.created.push(b);
      const id = String(b['id'] ?? '');
      if (!id) return json(res, 400, { error: { code: 'bad_request', message: 'the fake needs an id' } });
      if (this.sessions.some((x) => x.id === id) || this.foreignTmux.includes(id)) {
        return json(res, 409, { error: { code: 'session_exists', message: 'session id is taken: ' + id } });
      }
      const profile = String(b['profile'] ?? '');
      const prof = this.profiles.find((p) => p.name === profile);
      if (profile && this.profiles.length > 0 && !prof) {
        return json(res, 400, { error: { code: 'profile_not_found', message: 'profile not found: ' + profile } });
      }
      const parent = String(b['parent'] ?? '');
      const parentLabels = this.sessions.find((x) => x.id === parent)?.labels ?? {};
      const s = makeSession(id, {
        parent, dir: String(b['dir'] ?? ''), profile, agent: prof?.agent ?? 'claude-code',
        labels: { ...parentLabels, ...((b['labels'] as Record<string, string>) ?? {}) },
        spawn_dirs: (b['spawn_dirs'] as string[]) ?? [], state: 'running', activity: '',
      });
      this.sessions.push(s);
      this.publish('session.spawned', id, {});
      return json(res, 201, s);
    }
    if (req.method === 'POST' && (m = path.match(/^\/v1\/sessions\/([^/]+)\/kill$/))) {
      const id = decodeURIComponent(m[1]!);
      const s = this.sessions.find((x) => x.id === id);
      if (!s) return notFound(res, id);
      const final = (JSON.parse(body || '{}') as { final?: string }).final ?? 'killed';
      const stop = (x: Session) => {
        for (const c of this.sessions.filter((k) => k.parent === x.id)) stop(c);
        if (LIVE.has(x.state)) {
          x.state = final;
          this.publish('session.state_changed', x.id, { to: final });
        }
      };
      stop(s);
      return json(res, 200, s);
    }
    if (req.method === 'POST' && (m = path.match(/^\/v1\/sessions\/([^/]+)\/restore$/))) {
      const id = decodeURIComponent(m[1]!);
      const s = this.sessions.find((x) => x.id === id);
      if (!s) return notFound(res, id);
      if (s.state !== 'killed' && s.state !== 'errored') {
        return json(res, 409, { error: { code: 'restore_not_allowed', message: 'session cannot be restored from state: ' + s.state } });
      }
      s.state = 'running';
      this.publish('session.restored', id, {});
      return json(res, 200, s);
    }
    if (key === 'POST /v1/messages') {
      const b = JSON.parse(body || '{}') as { from?: string; to?: string; body?: string };
      const to = this.sessions.find((x) => x.id === b.to);
      if (!to) return notFound(res, String(b.to));
      if (!LIVE.has(to.state)) return json(res, 409, { error: { code: 'recipient_terminal', message: 'recipient session has ended' } });
      const msg = { id: this.messages.length + 1, to: to.id, body: String(b.body ?? ''), ...(b.from ? { from: b.from } : {}) };
      this.messages.push(msg);
      return json(res, 201, { ...msg, status: 'queued' });
    }
    if (key === 'POST /v1/posts') {
      const b = JSON.parse(body || '{}') as { from?: string; body?: string; labels?: Record<string, string>; attachments?: string[] };
      if (!b.body || !b.body.trim()) return json(res, 400, { error: { code: 'bad_request', message: 'body must not be empty' } });
      const from = b.from ?? '';
      const sess = from ? this.sessions.find((x) => x.id === from) : undefined;
      if (from && !sess) return json(res, 400, { error: { code: 'bad_request', message: 'from session not found' } });
      const p: Post = { id: this.posts.length + 1, from, labels: { ...(sess?.labels ?? {}), ...(b.labels ?? {}) }, body: b.body, attachments: b.attachments ?? [], created_at: Math.floor(Date.now() / 1000) };
      this.posts.push(p);
      this.publish('post.added', from, { id: p.id, post_labels: p.labels });
      return json(res, 201, p);
    }
    if (key === 'GET /v1/posts') {
      const want = labelFilter(url);
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return json(res, 200, { posts: this.posts.filter((p) => p.id > after && hasLabels(p.labels, want)).slice(0, limit) });
    }
    if (key === 'GET /v1/artifacts') {
      const want = labelFilter(url);
      const scope = url.searchParams.get('scope');
      let list = this.artifacts.filter((a) => (!scope || a.scope === scope) && hasLabels(a.labels, want));
      if (url.searchParams.get('versions') !== '1') {
        const latest = new Map<string, (typeof list)[number]>();
        for (const a of list) if ((latest.get(a.scope + '/' + a.name)?.version ?? 0) < a.version) latest.set(a.scope + '/' + a.name, a);
        list = [...latest.values()];
      }
      return json(res, 200, { artifacts: list });
    }
    if (req.method === 'GET' && (m = path.match(/^\/v1\/artifacts\/(\d+)$/))) {
      const a = this.artifacts.find((x) => x.id === Number(m![1]));
      if (!a) return json(res, 404, { error: { code: 'artifact_not_found', message: 'artifact not found' } });
      return json(res, 200, a);
    }
    if (key === 'GET /v1/model-profiles') {
      return json(res, 200, { profiles: this.profiles, default: this.defaultProfile ?? this.profiles[0]?.name ?? '' });
    }
    if (key === 'POST /v1/model-profiles') {
      const b = JSON.parse(body || '{}') as Partial<ModelProfile> & { name: string };
      if (this.profiles.some((p) => p.name === b.name)) return json(res, 409, { error: { code: 'profile_exists', message: 'profile ' + b.name + ' already exists' } });
      const p = makeProfile(b.name, { ...b, enabled: b.enabled ?? true, position: Math.max(-1, ...this.profiles.map((x) => x.position)) + 1 });
      this.profiles.push(p);
      return json(res, 201, p);
    }
    if (key === 'PUT /v1/model-profiles/default') {
      const name = (JSON.parse(body || '{}') as { name?: string }).name ?? '';
      const p = this.profiles.find((x) => x.name === name);
      if (!p) return json(res, 404, { error: { code: 'profile_not_found', message: 'no profile ' + name } });
      if (!p.enabled) return json(res, 400, { error: { code: 'profile_disabled', message: 'profile ' + name + ' is disabled' } });
      this.defaultProfile = name;
      return json(res, 200, { default: name });
    }
    if ((m = path.match(/^\/v1\/model-profiles\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!);
      const i = this.profiles.findIndex((x) => x.name === name);
      if (i < 0) return json(res, 404, { error: { code: 'profile_not_found', message: 'no profile ' + name } });
      if (req.method === 'PATCH') {
        this.profiles[i] = { ...this.profiles[i]!, ...(JSON.parse(body || '{}') as Partial<ModelProfile>), name };
        return json(res, 200, this.profiles[i]);
      }
      if (req.method === 'DELETE') {
        this.profiles.splice(i, 1);
        if (this.defaultProfile === name) this.defaultProfile = undefined;
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (key === 'GET /v1/model-catalog') return json(res, 200, { agents: this.catalogs });
    if (req.method === 'GET' && (m = path.match(/^\/v1\/session-ids\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      if (!/^[a-z0-9-]{1,63}$/.test(id)) return json(res, 400, { error: { code: 'invalid_id', message: 'invalid id' } });
      const by = this.sessions.some((x) => x.id === id) ? 'session' : this.foreignTmux.includes(id) ? 'tmux' : '';
      return json(res, 200, { id, free: by === '', taken_by: by });
    }
    if (req.method === 'DELETE' && (m = path.match(/^\/v1\/mailboxes\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!);
      const i = this.mailboxes.findIndex((b) => b.name === name);
      if (i < 0) return json(res, 404, { error: { code: 'mailbox_not_found', message: 'mailbox not found: ' + name } });
      this.mailboxes.splice(i, 1);
      return json(res, 200, { removed: name });
    }
    if (key === 'GET /v1/mailboxes') return json(res, 200, { mailboxes: this.mailboxes });
    if (key === 'POST /v1/mailboxes') {
      const name = String((JSON.parse(body || '{}') as { name?: string }).name ?? '');
      if (this.mailboxes.some((b) => b.name === name)) {
        return json(res, 409, { error: { code: 'mailbox_exists', message: 'mailbox exists: ' + name } });
      }
      this.mailboxes.push({ name, unread: 0, total: 0 });
      return json(res, 201, { name });
    }
    if (key === 'GET /v1/lessons') {
      const status = url.searchParams.get('status') || 'new';
      return json(res, 200, { lessons: status === 'all' ? this.lessons : this.lessons.filter((l) => l.status === status) });
    }
    if (req.method === 'POST' && (m = path.match(/^\/v1\/lessons\/(\d+)\/close$/))) {
      const l = this.lessons.find((x) => x.id === Number(m![1]));
      if (!l) return json(res, 404, { error: { code: 'lesson_not_found', message: 'lesson not found' } });
      if (l.status === 'new') {
        l.status = 'closed';
        l.closed_at = 2;
      }
      return json(res, 200, l);
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
      const want = labelFilter(url);
      let list = status === 'all' ? this.asks : this.asks.filter((a) => a.status === status);
      if (from) list = list.filter((a) => a.from === from);
      list = list.filter((a) => hasLabels(a.labels ?? {}, want));
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
      a.closed_at = Math.max(a.created_at, Math.floor(Date.now() / 1000));
      this.publish('ask.answered', a.from, { id: a.id, ask_labels: a.labels ?? {} });
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

function labelFilter(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of url.searchParams.getAll('label')) {
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

function hasLabels(have: Record<string, string>, want: Record<string, string>): boolean {
  return Object.entries(want).every(([k, v]) => have[k] === v);
}

function writeEvent(res: ServerResponse, e: DaemonEvent): void {
  res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const wait = (res as ServerResponse & { hoppDelay?: number }).hoppDelay ?? 0;
  const send = () => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
  };
  if (wait > 0) setTimeout(send, wait);
  else send();
}

function notFound(res: ServerResponse, id: string): void {
  json(res, 404, { error: { code: 'session_not_found', message: 'session not found: ' + id } });
}
