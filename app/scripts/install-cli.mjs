// Installs the app's commands into $HOPP_HOME/bin (~/.hopp/bin by default);
// the app also does this itself at every start:
// hopp-project, hopp-pipeline and hopp-task, small scripts that run the
// app's CLI bundle with the Node inside Electron (ELECTRON_RUN_AS_NODE), so
// no system Node is needed. `hopp task …` finds them there.
//
//   node scripts/install-cli.mjs app   the installed /Applications/hopp.app
//   node scripts/install-cli.mjs dev   this checkout: its Electron and out/cli
//
// Only these three files are written; an existing one is replaced atomically.
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const NOUNS = ['project', 'pipeline', 'task'];
const root = resolve(new URL('..', import.meta.url).pathname);
const mode = process.argv[2] ?? 'app';
const app = process.env.HOPP_APP_BUNDLE || '/Applications/hopp.app';

const targets = {
  app: { runtime: join(app, 'Contents', 'MacOS', 'hopp'), script: join(app, 'Contents', 'Resources', 'hopp-shell.cjs') },
  dev: {
    runtime: join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    script: join(root, 'out', 'cli', 'hopp-shell.cjs'),
  },
};
const t = targets[mode];
if (!t) {
  console.error(`usage: node scripts/install-cli.mjs app|dev`);
  process.exit(2);
}
for (const p of [t.runtime, t.script]) {
  if (!existsSync(p)) {
    console.error(`install-cli: ${p} is missing; ${mode === 'app' ? 'run `make app-install-mac` first' : 'run `npm run build:cli` first'}`);
    process.exit(1);
  }
}

const home = process.env.HOPP_HOME || join(homedir(), '.hopp');
const bin = join(home, 'bin');
mkdirSync(bin, { recursive: true, mode: 0o755 });
const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
for (const noun of NOUNS) {
  const body = [
    '#!/bin/sh',
    // Byte for byte what the app writes at its start (src/main/cliInstall.ts).
    `# hopp ${noun}: a command of the hopp desktop app, written by the app at its start (and by scripts/install-cli.mjs).`,
    `ELECTRON_RUN_AS_NODE=1 exec ${q(t.runtime)} ${q(t.script)} ${noun} "$@"`,
    '',
  ].join('\n');
  const dest = join(bin, 'hopp-' + noun);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  console.log('installed ' + dest);
}
