import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCommands, installLine, wrapperText } from './cliInstall';

let root: string;
let bin: string;
let bundle: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopp-cliinst-'));
  bin = join(root, 'home', 'bin');
  bundle = join(root, 'hopp-shell.cjs');
  writeFileSync(bundle, '// bundle\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('installCommands', () => {
  it('writes the three commands, executable, and nothing on the next start', async () => {
    const r = await installCommands(bin, '/Apps/hopp', bundle);
    expect(r.written.map((p) => p.slice(bin.length + 1))).toEqual(['hopp-project', 'hopp-pipeline', 'hopp-task']);
    expect(statSync(join(bin, 'hopp-task')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bin, 'hopp-task'), 'utf8')).toBe(wrapperText('/Apps/hopp', bundle, 'task'));
    expect(installLine(r)).toMatch(/^hopp: wrote hopp-project, hopp-pipeline, hopp-task in /);
    const again = await installCommands(bin, '/Apps/hopp', bundle);
    expect(again.written).toEqual([]);
    expect(installLine(again)).toMatch(/are up to date$/);
  });

  it('the app started last wins: another binary or bundle rewrites them', async () => {
    await installCommands(bin, '/Applications/hopp.app/Contents/MacOS/hopp', bundle);
    const r = await installCommands(bin, "/dev/it's/Electron", bundle);
    expect(r.written).toHaveLength(3);
    const text = readFileSync(join(bin, 'hopp-project'), 'utf8');
    expect(text).toContain(`'/dev/it'\\''s/Electron'`);
  });

  it('writes nothing when its bundle is missing, and says why', async () => {
    await expect(installCommands(bin, '/Apps/hopp', join(root, 'nope.cjs'))).rejects.toThrow(/bundle .*nope\.cjs is missing/);
  });

  it('runs: the script passes its arguments and the environment through', async () => {
    // A stand-in "runtime" that prints what it was given.
    const fake = join(root, 'runtime');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$@"\n', { mode: 0o755 });
    await installCommands(bin, fake, bundle);
    const out = execFileSync(join(bin, 'hopp-task'), ['new', '--brief', 'два слова']).toString();
    expect(out).toBe(`1|${bundle}|task|new|--brief|два слова|`);
  });

  it('writes byte for byte what scripts/install-cli.mjs writes', async () => {
    const appBundle = join(root, 'hopp.app');
    mkdirSync(join(appBundle, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(appBundle, 'Contents', 'Resources'), { recursive: true });
    writeFileSync(join(appBundle, 'Contents', 'MacOS', 'hopp'), '');
    writeFileSync(join(appBundle, 'Contents', 'Resources', 'hopp-shell.cjs'), '');
    const home = join(root, 'h2');
    execFileSync(process.execPath, [resolve(__dirname, '../../scripts/install-cli.mjs'), 'app'], {
      env: { ...process.env, HOPP_HOME: home, HOPP_APP_BUNDLE: appBundle },
    });
    const r = await installCommands(join(home, 'bin'), join(appBundle, 'Contents', 'MacOS', 'hopp'), join(appBundle, 'Contents', 'Resources', 'hopp-shell.cjs'));
    expect(r.written).toEqual([]);
  });
});
