// TerminalManager runs one pseudo-terminal per open session view. The pty
// runs the attach command the daemon returns (a tmux client), so the app is
// one more client of the session. Closing a terminal hangs up that client:
// tmux detaches it and the session keeps running.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import * as pty from 'node-pty';

export interface AttachSource {
  attachCommand(sessionId: string): Promise<string[]>;
}

interface Events {
  data: [termId: string, data: string];
  exit: [termId: string, code: number, signal: number];
}

// GUI apps on macOS start with a short PATH; tmux and hopp usually live in
// Homebrew's bin.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export function searchPath(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const d of EXTRA_PATH) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

// resolveExecutable finds a command name on the search path; an absolute or
// relative path is returned as it is. Undefined when not found.
export function resolveExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(cmd) || cmd.includes('/')) return existsSync(cmd) ? cmd : undefined;
  for (const d of searchPath(env)) {
    const p = join(d, cmd);
    if (existsSync(p)) return p;
  }
  return undefined;
}

// childEnv is the environment of an attach command: the app's own, minus the
// variables that would make tmux think it runs inside another tmux.
export function childEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['PATH'] = searchPath(base).join(delimiter);
  return env;
}

// After a hangup, a client that is still alive this long is killed.
const KILL_AFTER_MS = 2000;

export class TerminalManager extends EventEmitter<Events> {
  private terms = new Map<string, pty.IPty>();
  private seq = 0;

  constructor(private readonly source: AttachSource) {
    super();
  }

  get openCount(): number {
    return this.terms.size;
  }

  async open(sessionId: string, cols: number, rows: number): Promise<string> {
    const argv = await this.source.attachCommand(sessionId);
    if (!argv.length) throw new Error('the daemon returned an empty attach command');
    const env = childEnv(process.env);
    const file = resolveExecutable(argv[0]!, env);
    if (!file) throw new Error(`cannot find ${argv[0]} on PATH`);
    const p = pty.spawn(file, argv.slice(1), {
      name: 'xterm-256color',
      cols: clamp(cols),
      rows: clamp(rows),
      cwd: homedir(),
      env,
    });
    const id = 't' + ++this.seq;
    this.terms.set(id, p);
    p.onData((d) => this.emit('data', id, d));
    p.onExit(({ exitCode, signal }) => {
      this.terms.delete(id);
      this.emit('exit', id, exitCode, signal ?? 0);
    });
    return id;
  }

  write(termId: string, data: string): void {
    this.terms.get(termId)?.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    const p = this.terms.get(termId);
    if (!p) return;
    try {
      p.resize(clamp(cols), clamp(rows));
    } catch {
      // The process may have just exited.
    }
  }

  // close hangs up the terminal (SIGHUP to the client, as when a terminal
  // window closes). A tmux client detaches on it; the session stays.
  close(termId: string): void {
    const p = this.terms.get(termId);
    if (!p) return;
    this.terms.delete(termId);
    const pid = p.pid;
    try {
      p.kill('SIGHUP');
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // exited
      }
    }, KILL_AFTER_MS).unref();
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}

function clamp(n: number): number {
  return Math.max(2, Math.min(1000, Math.floor(n) || 2));
}
