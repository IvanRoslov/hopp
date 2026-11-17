// A GUI app on macOS starts with a short PATH (no ~/.local/bin, no Homebrew,
// no node version manager). The daemon the app may start, and the attach
// commands it runs, need the PATH the user's own shell has, so the app reads
// it from a login shell once at startup.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

const MARK = '__HOPP_PATH__';

// loginShellPath runs the user's shell as an interactive login shell and
// returns its PATH; undefined when the shell fails or takes too long. A
// shell with a heavy profile can need ten seconds and more, hence the bound.
export function loginShellPath(shell: string, timeoutMs = 30_000): Promise<string | undefined> {
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

// A GUI app on macOS starts with no locale at all (no LANG, no LC_*). tmux
// then treats its client as not UTF-8 and draws every non-ASCII character as
// "_": the harness logo, the prompt mark, arrows. ensureUtf8Locale gives the
// environment a UTF-8 locale when it has none, and leaves a UTF-8 one alone.
export function ensureUtf8Locale(env: NodeJS.ProcessEnv): void {
  const effective = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  if (/utf-?8/i.test(effective)) return;
  if (env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
  if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
  env['LC_CTYPE'] = 'en_US.UTF-8';
}

// The login shell can be slow, so its PATH is remembered between runs: the
// next start uses the remembered one at once and refreshes it in the
// background. readPathCache returns undefined when nothing usable is stored.
export function readPathCache(file: string): string | undefined {
  try {
    const v = readFileSync(file, 'utf8').trim();
    return v && !v.includes('\n') ? v : undefined;
  } catch {
    return undefined;
  }
}

export function writePathCache(file: string, path: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, path + '\n');
  } catch {
    // a cache that cannot be written only costs the next start its wait
  }
}
