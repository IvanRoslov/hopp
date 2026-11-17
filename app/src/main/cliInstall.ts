// The app's commands (hopp project, hopp pipeline, hopp task) are installed
// by the app itself at every start: $HOPP_HOME/bin/hopp-<noun>, small scripts
// that run the CLI bundle with this app's own binary as Node. A script is
// written only when it is missing or names another binary or bundle, so the
// app started last (a dev checkout, or /Applications/hopp.app) is the one the
// commands run. scripts/install-cli.mjs writes the same scripts.
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const CLI_NOUNS = ['project', 'pipeline', 'task'] as const;

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// wrapperText: the script of one command. Keep it byte for byte equal to
// what scripts/install-cli.mjs writes.
export function wrapperText(runtime: string, script: string, noun: string): string {
  return [
    '#!/bin/sh',
    `# hopp ${noun}: a command of the hopp desktop app, written by the app at its start (and by scripts/install-cli.mjs).`,
    `ELECTRON_RUN_AS_NODE=1 exec ${q(runtime)} ${q(script)} ${noun} "$@"`,
    '',
  ].join('\n');
}

export interface InstallResult {
  bin: string;
  written: string[];
  unchanged: string[];
}

// installCommands writes the scripts that differ; it throws only on a write
// that failed (the caller logs it and carries on).
export async function installCommands(bin: string, runtime: string, script: string): Promise<InstallResult> {
  if (!existsSync(script)) throw new Error(`the command bundle ${script} is missing (build it with \`npm run build\`)`);
  await mkdir(bin, { recursive: true, mode: 0o755 });
  const out: InstallResult = { bin, written: [], unchanged: [] };
  for (const noun of CLI_NOUNS) {
    const dest = join(bin, 'hopp-' + noun);
    const body = wrapperText(runtime, script, noun);
    const cur = await readFile(dest, 'utf8').catch(() => null);
    if (cur === body) {
      out.unchanged.push(dest);
      continue;
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      const f = await open(tmp, 'w', 0o755);
      try {
        await f.writeFile(body);
      } finally {
        await f.close();
      }
      await chmod(tmp, 0o755);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    out.written.push(dest);
  }
  return out;
}

// installLine: the one log line of a start.
export function installLine(r: InstallResult): string {
  if (r.written.length === 0) return `hopp: the commands hopp project, pipeline and task in ${r.bin} are up to date`;
  return `hopp: wrote ${r.written.map((p) => p.slice(r.bin.length + 1)).join(', ')} in ${r.bin} (this app now runs \`hopp task\` and the others)`;
}
