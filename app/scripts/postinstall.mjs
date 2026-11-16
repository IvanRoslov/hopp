// Runs after `npm install` / `npm ci` in app/.
//
// 1. node-pty 1.1.0 ships its macOS spawn-helper without the executable bit,
//    and every spawn then fails with "posix_spawnp failed". Set the bit.
// 2. electron 45 downloads its binary lazily; fetch it now so tests and
//    `npm run dev` never download in the middle of a run.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const prebuilds = join(root, 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

const electronInstall = join(root, 'node_modules', 'electron', 'install.js');
if (existsSync(electronInstall) && !existsSync(join(root, 'node_modules', 'electron', 'path.txt'))) {
  const r = spawnSync(process.execPath, [electronInstall], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
