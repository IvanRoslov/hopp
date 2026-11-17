// DaemonClient talks to the hopp daemon over its Unix socket. It is the only
// way the app reads or changes daemon state: never the daemon's database.
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Artifact, Lesson, ModelProfile, Post } from '../../shared/shell';

// StoredArtifact is an artifact version as the daemon returns it, with the
// path of its stored file. The path never goes to the page.
export interface StoredArtifact extends Artifact {
  path: string;
}
import type { Ask, AskAnswer, Health, QuizAnswer, Session, Waiting } from '../../shared/types';

// RawCatalog is one harness's entry of GET /v1/model-catalog.
export interface RawCatalog {
  agent: string;
  source: string;
  warning: string;
  models: { id: string; name: string; description: string; main: boolean; efforts: string[] | null }[] | null;
}

// CreateSessionBody is the request of POST /v1/sessions.
export interface CreateSessionBody {
  dir: string;
  id?: string;
  parent?: string;
  labels?: Record<string, string>;
  spawn_dirs?: string[];
  profile?: string;
  system_prompt?: string;
  message?: string;
}

// DaemonError is a request the daemon answered with an error status.
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}

// DaemonUnavailable is a request that reached no daemon: the socket is
// missing or nothing listens on it, or the daemon did not answer in time.
// neverSent tells the first case (nothing could have happened) from the
// others (the daemon may have acted before going quiet).
export class DaemonUnavailable extends Error {
  constructor(
    readonly socketPath: string,
    readonly cause?: unknown,
  ) {
    super(`hopp daemon is not running (socket ${socketPath})`);
    this.name = 'DaemonUnavailable';
  }

  get neverSent(): boolean {
    const code = (this.cause as { code?: string } | undefined)?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK';
  }
}

// resolveHoppHome returns $HOPP_HOME, or ~/.hopp.
export function resolveHoppHome(env: NodeJS.ProcessEnv | Record<string, string | undefined>, home = homedir()): string {
  const h = env['HOPP_HOME'];
  return h ? h : join(home, '.hopp');
}

// resolveSocketPath returns $HOPP_HOME/hopp.sock, or ~/.hopp/hopp.sock.
export function resolveSocketPath(env: NodeJS.ProcessEnv | Record<string, string | undefined>, home = homedir()): string {
  return join(resolveHoppHome(env, home), 'hopp.sock');
}

const UNAVAILABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTSOCK', 'EPIPE']);

export function isUnavailableError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && UNAVAILABLE_CODES.has(code);
}

const enc = encodeURIComponent;

export class DaemonClient {
  // spawnTimeoutMs bounds a session launch: the daemon answers it only after
  // the agent's tmux session exists, which can take long on a cold start.
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 10_000,
    private readonly spawnTimeoutMs = 120_000,
  ) {}

  health(): Promise<Health> {
    return this.call('GET', '/v1/health');
  }

  async listSessions(opts: { all?: boolean; parent?: string } = {}): Promise<Session[]> {
    const q = new URLSearchParams();
    if (opts.all) q.set('all', '1');
    if (opts.parent) q.set('parent', opts.parent);
    const qs = q.toString();
    const r = await this.call<{ sessions: Session[] }>('GET', '/v1/sessions' + (qs ? '?' + qs : ''));
    return r.sessions;
  }

  getSession(id: string): Promise<Session> {
    return this.call('GET', `/v1/sessions/${enc(id)}`);
  }

  async attachCommand(id: string): Promise<string[]> {
    const r = await this.call<{ command: string[] }>('GET', `/v1/sessions/${enc(id)}/attach`);
    return r.command;
  }

  async listAsks(opts: { status?: 'open' | 'answered' | 'withdrawn' | 'all'; from?: string; labels?: Record<string, string> } = {}): Promise<Ask[]> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.from) q.set('from', opts.from);
    for (const [k, v] of Object.entries(opts.labels ?? {})) q.append('label', `${k}=${v}`);
    const qs = q.toString();
    const r = await this.call<{ asks: Ask[] }>('GET', '/v1/asks' + (qs ? '?' + qs : ''));
    return r.asks;
  }

  answerAsk(id: number, body: AskAnswer): Promise<Ask> {
    return this.call('POST', `/v1/asks/${enc(String(id))}/answer`, body);
  }

  // dismissAsk: the human closes an ask without an answer; the asker is told.
  dismissAsk(id: number): Promise<Ask> {
    return this.call('POST', `/v1/asks/${enc(String(id))}/dismiss`, {});
  }

  answerQuiz(sessionId: string, body: QuizAnswer): Promise<{ status: string }> {
    return this.call('POST', `/v1/sessions/${enc(sessionId)}/quiz/answer`, body);
  }

  waiting(): Promise<Waiting> {
    return this.call('GET', '/v1/waiting');
  }

  // createSession launches a session (POST /v1/sessions).
  createSession(body: CreateSessionBody): Promise<Session> {
    return this.call('POST', '/v1/sessions', body, this.spawnTimeoutMs);
  }

  // killSession stops a session and its live descendants; final is "killed"
  // (default) or "done".
  killSession(id: string, final?: 'killed' | 'done'): Promise<Session> {
    return this.call('POST', `/v1/sessions/${enc(id)}/kill`, final ? { final } : {});
  }

  restoreSession(id: string): Promise<Session> {
    return this.call('POST', `/v1/sessions/${enc(id)}/restore`, {});
  }

  async listModelProfiles(): Promise<{ profiles: ModelProfile[]; default: string }> {
    const r = await this.call<{ profiles: ModelProfile[] | null; default?: string }>('GET', '/v1/model-profiles');
    return { profiles: r.profiles ?? [], default: r.default ?? '' };
  }

  createModelProfile(body: Partial<ModelProfile> & { name: string }): Promise<ModelProfile> {
    return this.call('POST', '/v1/model-profiles', body);
  }

  patchModelProfile(name: string, body: Partial<ModelProfile>): Promise<ModelProfile> {
    return this.call('PATCH', `/v1/model-profiles/${enc(name)}`, body);
  }

  async deleteModelProfile(name: string): Promise<void> {
    await this.call('DELETE', `/v1/model-profiles/${enc(name)}`);
  }

  async setDefaultProfile(name: string): Promise<void> {
    await this.call('PUT', '/v1/model-profiles/default', { name });
  }

  async modelCatalog(refresh = false): Promise<RawCatalog[]> {
    const r = await this.call<{ agents: RawCatalog[] | null }>('GET', '/v1/model-catalog' + (refresh ? '?refresh=1' : ''), undefined, this.spawnTimeoutMs);
    return r.agents ?? [];
  }

  async listMailboxes(): Promise<{ name: string; unread: number; total: number }[]> {
    const r = await this.call<{ mailboxes: { name: string; unread: number; total: number }[] | null }>('GET', '/v1/mailboxes');
    return r.mailboxes ?? [];
  }

  addMailbox(name: string): Promise<{ name: string }> {
    return this.call('POST', '/v1/mailboxes', { name });
  }

  async removeMailbox(name: string): Promise<void> {
    await this.call('DELETE', `/v1/mailboxes/${enc(name)}`);
  }

  // sessionIdHolder: what holds a session id a launch would refuse
  // ("session" or "tmux"), "" when it is free, or null from a daemon that
  // predates the question.
  async sessionIdHolder(id: string): Promise<'session' | 'tmux' | '' | null> {
    try {
      const r = await this.call<{ taken_by: string }>('GET', `/v1/session-ids/${enc(id)}`);
      return r.taken_by === 'session' || r.taken_by === 'tmux' ? r.taken_by : '';
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404 && err.code === 'not_found') return null;
      throw err;
    }
  }

  async listLessons(status: 'new' | 'closed' | 'all', labels: Record<string, string> = {}): Promise<Lesson[]> {
    let q = '/v1/lessons?status=' + enc(status);
    for (const [k, v] of Object.entries(labels)) q += '&label=' + enc(`${k}=${v}`);
    const r = await this.call<{ lessons: Lesson[] | null }>('GET', q);
    return r.lessons ?? [];
  }

  // setLessonLabels sets each label; an empty value removes the key.
  setLessonLabels(id: number, labels: Record<string, string>): Promise<Lesson> {
    return this.call('PATCH', `/v1/lessons/${enc(String(id))}`, { labels });
  }

  closeLesson(id: number): Promise<Lesson> {
    return this.call('POST', `/v1/lessons/${enc(String(id))}/close`, {});
  }

  async listPosts(opts: { labels?: Record<string, string>; after?: number; limit?: number } = {}): Promise<Post[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.labels ?? {})) q.append('label', `${k}=${v}`);
    if (opts.after) q.set('after', String(opts.after));
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    const r = await this.call<{ posts: Post[] | null }>('GET', '/v1/posts' + (qs ? '?' + qs : ''));
    return r.posts ?? [];
  }

  createPost(body: { from?: string; body: string; labels?: Record<string, string>; attachments?: string[] }): Promise<Post> {
    return this.call('POST', '/v1/posts', body);
  }

  async listArtifacts(opts: { scope?: string; labels?: Record<string, string>; versions?: boolean } = {}): Promise<StoredArtifact[]> {
    const q = new URLSearchParams();
    if (opts.scope) q.set('scope', opts.scope);
    for (const [k, v] of Object.entries(opts.labels ?? {})) q.append('label', `${k}=${v}`);
    if (opts.versions) q.set('versions', '1');
    const qs = q.toString();
    const r = await this.call<{ artifacts: StoredArtifact[] | null }>('GET', '/v1/artifacts' + (qs ? '?' + qs : ''));
    return r.artifacts ?? [];
  }

  getArtifact(id: number): Promise<StoredArtifact> {
    return this.call('GET', `/v1/artifacts/${enc(String(id))}`);
  }

  // sendMessage queues a message; without from it carries no sender prefix.
  sendMessage(body: { to: string; body: string; from?: string }): Promise<{ id: number; status: string }> {
    return this.call('POST', '/v1/messages', body);
  }

  private call<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            Host: 'hopp',
            Accept: 'application/json',
            ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (text += c));
          res.on('error', (err) => reject(isUnavailableError(err) ? new DaemonUnavailable(this.socketPath, err) : err));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            const e = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
            reject(new DaemonError(status, e?.code ?? 'http_' + status, e?.message ?? (text.trim() || `HTTP ${status}`)));
          });
        },
      );
      req.on('timeout', () => req.destroy(new DaemonUnavailable(this.socketPath, new Error('timeout'))));
      req.on('error', (err) => {
        if (err instanceof DaemonUnavailable) reject(err);
        else reject(isUnavailableError(err) ? new DaemonUnavailable(this.socketPath, err) : err);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}
