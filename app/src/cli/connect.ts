// Where a `hopp task …` command does its work. When the app runs, it serves
// the shell API on its socket and the command asks it; when it does not, the
// command runs the same ShellService itself, against the same store (the
// store's lock file keeps two writers apart). Both answer the same ShellApi.
import { request } from 'node:http';
import { DaemonClient, resolveHoppHome, resolveSocketPath } from '../main/daemon/client';
import { makeRunner } from '../main/shell/exec';
import { privateDirOk, PROGRESS_HEADER, shellSocketPath, type CliMethod } from '../main/shell/server';
import { ShellService } from '../main/shell/service';
import { ShellStore } from '../main/shell/store';
import type { ModelProfile, Result, ShellState, Task, TaskFeed, TaskInput } from '../shared/shell';

export interface ShellApi {
  state(): Promise<ShellState>;
  listProfiles(): Promise<ModelProfile[]>;
  // say hears a line on each slow step of the launch.
  createTask(input: TaskInput, say?: (line: string) => void): Promise<Result<Task>>;
  stopTask(id: string): Promise<Result<null>>;
  resumeTask(id: string): Promise<Result<null>>;
  finishTask(id: string): Promise<Result<null>>;
  taskFeed(id: string): Promise<TaskFeed>;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface Homes {
  hoppHome: string;
  appHome: string;
  daemonSocket: string;
  shellSocket: string;
}

// homes resolves the folders exactly as the app does.
export function homes(env: Env): Homes {
  const hoppHome = resolveHoppHome(env);
  const appHome = env['HOPP_APP_HOME'] || hoppHome;
  return { hoppHome, appHome, daemonSocket: env['HOPP_SOCKET'] || resolveSocketPath(env), shellSocket: shellSocketPath(appHome) };
}

export class AppError extends Error {}

const LAUNCH_TIMEOUT_MS = 10 * 60_000;

// RemoteShell calls the app over its socket.
export class RemoteShell implements ShellApi {
  constructor(readonly socketPath: string) {}

  private call<T>(method: CliMethod, args: unknown[], timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ args });
      const req = request(
        {
          socketPath: this.socketPath, path: '/v1/shell/' + method, method: 'POST', timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let parsed: { value?: T; error?: { message?: string } };
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new AppError(`the app answered ${method} with something that is not JSON`));
              return;
            }
            if (res.statusCode === 200) resolve(parsed.value as T);
            else reject(new AppError(parsed.error?.message ?? `the app answered ${method} with status ${res.statusCode}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new AppError(`the app did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`)));
      req.on('error', (err) => reject(err instanceof AppError ? err : new AppError(`the app's socket failed: ${err.message}`)));
      req.end(body);
    });
  }

  state = () => this.call<ShellState>('state', []);
  listProfiles = () => this.call<ModelProfile[]>('listProfiles', []);
  // A launch fetches (up to 60 s a clone) and waits for the spawn (up to
  // 120 s). With say, the app sends the launch's steps as it goes.
  createTask = (input: TaskInput, say?: (line: string) => void) =>
    say ? this.launch(input, say) : this.call<Result<Task>>('createTask', [input], LAUNCH_TIMEOUT_MS);

  private launch(input: TaskInput, say: (line: string) => void): Promise<Result<Task>> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ args: [input] });
      const req = request(
        {
          socketPath: this.socketPath, path: '/v1/shell/createTask', method: 'POST', timeout: LAUNCH_TIMEOUT_MS,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), [PROGRESS_HEADER]: '1' },
        },
        (res) => {
          const streamed = String(res.headers['content-type'] ?? '').startsWith('application/x-ndjson');
          let buf = '';
          let answer: { value?: Result<Task>; error?: { message?: string } } | undefined;
          const take = (line: string) => {
            if (!line.trim()) return;
            let o: { progress?: unknown; value?: Result<Task>; error?: { message?: string } };
            try {
              o = JSON.parse(line);
            } catch {
              reject(new AppError('the app answered createTask with something that is not JSON'));
              return;
            }
            if (streamed && typeof o.progress === 'string') say(o.progress);
            else answer = o;
          };
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            buf += c;
            if (!streamed) return;
            let i: number;
            while ((i = buf.indexOf('\n')) >= 0) {
              take(buf.slice(0, i));
              buf = buf.slice(i + 1);
            }
          });
          res.on('end', () => {
            take(buf);
            if (res.statusCode === 200 && answer && 'value' in answer) resolve(answer.value as Result<Task>);
            else reject(new AppError(answer?.error?.message ?? `the app answered createTask with status ${res.statusCode}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new AppError(`the app did not answer createTask within ${Math.round(LAUNCH_TIMEOUT_MS / 60_000)} min`)));
      req.on('error', (err) => reject(err instanceof AppError ? err : new AppError(`the app's socket failed: ${err.message}`)));
      req.end(body);
    });
  }
  stopTask = (id: string) => this.call<Result<null>>('stopTask', [id], 60_000);
  resumeTask = (id: string) => this.call<Result<null>>('resumeTask', [id], 3 * 60_000);
  finishTask = (id: string) => this.call<Result<null>>('finishTask', [id], 60_000);
  taskFeed = (id: string) => this.call<TaskFeed>('taskFeed', [id], 60_000);
}

// appAnswers: the app serves the socket. No socket file, or nobody
// listening on it, means the app is closed; anything else is an error, so a
// hung app is never bypassed by accident.
export function appAnswers(socketPath: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/health', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => req.destroy(new AppError(`the hopp app does not answer on ${socketPath}; quit and reopen it`)));
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') resolve(false);
      else reject(err instanceof AppError ? err : new AppError(`the app's socket ${socketPath} failed: ${err.message}`));
    });
    req.end();
  });
}

// localShell: the ShellService of the app, run in this process.
export async function localShell(env: Env, h: Homes): Promise<ShellApi> {
  const childEnv = () => ({ ...process.env, HOPP_HOME: h.hoppHome });
  // The hopp binary that ran this command (the dispatcher sets HOPP_BIN).
  const hoppBin = env['HOPP_BIN'] || 'hopp';
  const svc = new ShellService({
    home: h.hoppHome,
    store: new ShellStore(h.appHome),
    client: new DaemonClient(h.daemonSocket),
    git: makeRunner('git', childEnv),
    hopp: makeRunner(hoppBin, childEnv),
    gh: makeRunner('gh', childEnv, 30 * 60_000),
    pickFolder: async () => null,
  });
  // As the app does on start: the starter pipelines, once per store.
  await svc.seedPipelines();
  return svc;
}

export async function connectShell(env: Env): Promise<{ api: ShellApi; via: 'app' | 'local' }> {
  const h = homes(env);
  if ((await privateDirOk(h.shellSocket, false)) && (await appAnswers(h.shellSocket))) return { api: new RemoteShell(h.shellSocket), via: 'app' };
  return { api: await localShell(env, h), via: 'local' };
}
