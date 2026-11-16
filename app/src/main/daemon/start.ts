// startDaemon runs `hopp daemon start` with the hopp found on PATH (plus the
// usual Homebrew directories, since GUI apps start with a short PATH).
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolveExecutable, searchPath } from '../terminal/manager';

export async function startDaemon(
  env: NodeJS.ProcessEnv = process.env,
  extraPath?: string[],
): Promise<{ ok: boolean; message: string }> {
  const hopp = resolveExecutable('hopp', env, extraPath);
  if (!hopp) {
    return { ok: false, message: `hopp was not found on PATH (${searchPath(env, extraPath).join(delimiter)})` };
  }
  const childEnv = { ...env, PATH: searchPath(env, extraPath).join(delimiter) };
  return new Promise((resolve) => {
    execFile(hopp, ['daemon', 'start'], { env: childEnv, timeout: 30_000 }, (err, stdout, stderr) => {
      const out = (String(stderr).trim() || String(stdout).trim()).split('\n').slice(-5).join('\n');
      if (err) resolve({ ok: false, message: out || err.message });
      else resolve({ ok: true, message: String(stdout).trim() || 'started' });
    });
  });
}
