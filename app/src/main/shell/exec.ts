// Small wrappers around the two programs the shell layer runs: git (only in
// repositories the human named, and only `worktree add`/`remove`, `branch -D`
// and read-only queries) and the hopp CLI (for the tool catalog).
import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

// RunError is a program that exited non-zero; message is its stderr (or the
// spawn error).
export class RunError extends Error {
  constructor(
    message: string,
    readonly stdout = '',
    readonly stderr = '',
    readonly code: number | string | null = null,
  ) {
    super(message);
    this.name = 'RunError';
  }
}

export type Runner = (args: string[], opts?: { cwd?: string; input?: string }) => Promise<RunResult>;

export function makeRunner(program: string | (() => string | null), env: () => NodeJS.ProcessEnv, timeoutMs = 60_000): Runner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const bin = typeof program === 'string' ? program : program();
      if (!bin) {
        reject(new RunError('program not found on PATH'));
        return;
      }
      const child = execFile(
        bin,
        args,
        { cwd: opts.cwd, env: env(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String(stderr).trim() || err.message;
            reject(new RunError(msg, String(stdout), String(stderr), (err as NodeJS.ErrnoException).code ?? null));
            return;
          }
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
}
