// DaemonClient talks to the hopp daemon over its Unix socket. It is the only
// way the app reads or changes daemon state: never the daemon's database.
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ask, AskAnswer, Health, QuizAnswer, Session, Waiting } from '../../shared/types';

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
// missing or nothing listens on it.
export class DaemonUnavailable extends Error {
  constructor(
    readonly socketPath: string,
    readonly cause?: unknown,
  ) {
    super(`hopp daemon is not running (socket ${socketPath})`);
    this.name = 'DaemonUnavailable';
  }
}

// resolveSocketPath returns $HOPP_HOME/hopp.sock, or ~/.hopp/hopp.sock.
export function resolveSocketPath(env: NodeJS.ProcessEnv | Record<string, string | undefined>, home = homedir()): string {
  const h = env['HOPP_HOME'];
  return join(h ? h : join(home, '.hopp'), 'hopp.sock');
}

const UNAVAILABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTSOCK', 'EPIPE']);

export function isUnavailableError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && UNAVAILABLE_CODES.has(code);
}

const enc = encodeURIComponent;

export class DaemonClient {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 10_000,
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

  async listAsks(opts: { status?: 'open' | 'answered' | 'withdrawn' | 'all'; from?: string } = {}): Promise<Ask[]> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.from) q.set('from', opts.from);
    const qs = q.toString();
    const r = await this.call<{ asks: Ask[] }>('GET', '/v1/asks' + (qs ? '?' + qs : ''));
    return r.asks;
  }

  answerAsk(id: number, body: AskAnswer): Promise<Ask> {
    return this.call('POST', `/v1/asks/${enc(String(id))}/answer`, body);
  }

  answerQuiz(sessionId: string, body: QuizAnswer): Promise<{ status: string }> {
    return this.call('POST', `/v1/sessions/${enc(sessionId)}/quiz/answer`, body);
  }

  waiting(): Promise<Waiting> {
    return this.call('GET', '/v1/waiting');
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
          timeout: this.timeoutMs,
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
