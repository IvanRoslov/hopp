// The shell API on a Unix socket, for the hopp CLI (`hopp task …`): the same
// service the page uses, JSON over HTTP like the daemon's socket. Only the
// methods the CLI needs are served. The socket file is the user's alone
// (mode 0600), so another user cannot connect.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { ArgError, callShell, createTaskSaying } from './ipc';
import type { ShellService } from './service';

// The methods a CLI may call. pickFolder (a dialog) and everything that
// edits projects, pipelines, agents or profiles stay with the page.
export const CLI_METHODS = ['state', 'listProfiles', 'createTask', 'stopTask', 'resumeTask', 'addTaskWorkers', 'finishTask', 'taskFeed'] as const;
export type CliMethod = (typeof CLI_METHODS)[number];

const BODY_MAX = 8 * 1024 * 1024;
// macOS refuses a socket path longer than 103 bytes.
const SUN_PATH_MAX = 103;

// shellSocketPath: <app home>/shell.sock, or, when that path is too long for
// a Unix socket, /tmp/hopp-<uid>/shell-<hash of the app home>.sock. Not the
// per-user temp folder: its path depends on $TMPDIR, which the app and an
// agent's tmux session may not share.
export function shellSocketPath(appHome: string, base = '/tmp'): string {
  const p = join(appHome, 'shell.sock');
  if (Buffer.byteLength(p) <= SUN_PATH_MAX) return p;
  const h = createHash('sha256').update(appHome).digest('hex').slice(0, 16);
  return join(base, `hopp-${process.getuid?.() ?? 0}`, `shell-${h}.sock`);
}

const isFallback = (path: string) => /^hopp-\d+$/.test(basename(dirname(path))) && /^shell-[0-9a-f]{16}\.sock$/.test(basename(path));

// privateDirOk: the folder of a socket outside the app home is a real folder
// of this user that nobody else can enter (made so when create is set). In a
// shared /tmp anyone could make it first; then it is not used.
export async function privateDirOk(path: string, create: boolean): Promise<boolean> {
  if (!isFallback(path)) return true;
  const dir = dirname(path);
  if (create) await mkdir(dir, { mode: 0o700 }).catch(() => undefined);
  try {
    const st = await lstat(dir);
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_MAX) {
        reject(new ArgError('the request is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// A CLI that sends this header with createTask gets the launch's steps as
// they happen: lines of JSON, each {"progress": "<text>"}, and last the
// answer, {"value": …}. An app without this answers plain JSON as before.
export const PROGRESS_HEADER = 'x-hopp-progress';

async function streamLaunch(svc: ShellService, args: unknown[], res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const line = (o: unknown) => {
    if (!res.writableEnded) res.write(JSON.stringify(o) + '\n');
  };
  const value = await createTaskSaying(svc, args, (progress) => line({ progress }));
  line({ value });
  res.end();
}

async function handle(svc: ShellService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/v1/health') return send(res, 200, { ok: true, pid: process.pid });
  const m = /^\/v1\/shell\/([A-Za-z]+)$/.exec(url);
  if (!m || !(CLI_METHODS as readonly string[]).includes(m[1]!)) return send(res, 404, { error: { code: 'not_found', message: 'no such method' } });
  if (req.method !== 'POST') return send(res, 405, { error: { code: 'method_not_allowed', message: 'use POST' } });
  let args: unknown[];
  try {
    const raw = await readBody(req);
    const body = raw.trim() ? (JSON.parse(raw) as { args?: unknown }) : {};
    if (body.args !== undefined && !Array.isArray(body.args)) throw new ArgError('args must be a list');
    args = (body.args as unknown[] | undefined) ?? [];
  } catch (err) {
    return send(res, 400, { error: { code: 'bad_request', message: err instanceof ArgError ? err.message : 'the body is not JSON' } });
  }
  if (m[1] === 'createTask' && req.headers[PROGRESS_HEADER] === '1') return streamLaunch(svc, args, res);
  try {
    const value = await callShell(svc, m[1]!, args);
    send(res, 200, { value: value ?? null });
  } catch (err) {
    const code = err instanceof ArgError ? 'bad_request' : 'internal_error';
    send(res, code === 'bad_request' ? 400 : 500, { error: { code, message: err instanceof Error ? err.message : String(err) } });
  }
}

// inUse: something answers on the socket.
function inUse(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export interface ShellServer {
  path: string;
  close(): Promise<void>;
}

// serveShell listens on path. A leftover socket file nobody answers on is
// replaced; a live one is an error (another app serves this home).
export async function serveShell(svc: ShellService, path: string): Promise<ShellServer> {
  if (!(await privateDirOk(path, true))) throw new Error(`${dirname(path)} is not a folder of this user alone; the socket is not served there`);
  if (existsSync(path)) {
    if (await inUse(path)) throw new Error(`${path} is served by another process`);
    await unlink(path);
  }
  const server: Server = createServer((req, res) => {
    handle(svc, req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: { code: 'internal_error', message: String(err) } });
    });
  });
  // The socket is created 0600: no moment in which another user could
  // connect. listen binds synchronously, so the umask is restored at once
  // and nothing else of this process creates files under it.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const old = process.umask(0o177);
    try {
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(old);
    }
  });
  await chmod(path, 0o600);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        unlink(path).catch(() => undefined);
      }),
  };
}
