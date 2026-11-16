// A GUI app on macOS starts with a short PATH (no ~/.local/bin, no Homebrew,
// no node version manager). The daemon the app may start, and the attach
// commands it runs, need the PATH the user's own shell has, so the app reads
// it from a login shell once at startup.
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

const MARK = '__HOPP_PATH__';

// loginShellPath runs the user's shell as an interactive login shell and
// returns its PATH; undefined when the shell fails or takes too long.
export function loginShellPath(shell: string, timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        shell,
        ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
        { timeout: timeoutMs, killSignal: 'SIGKILL', env: process.env },
        (err, stdout) => {
          if (err) return resolve(undefined);
          const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(String(stdout));
          resolve(m && m[1] ? m[1] : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

// mergePath puts the login shell's directories first and keeps any others.
export function mergePath(current: string | undefined, login: string | undefined): string {
  const out: string[] = [];
  for (const p of [...(login ?? '').split(delimiter), ...(current ?? '').split(delimiter)]) {
    if (p && !out.includes(p)) out.push(p);
  }
  return out.join(delimiter);
}
