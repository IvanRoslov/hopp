import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureUtf8Locale, loginShellPath, mergePath, readPathCache, writePathCache } from './shellEnv';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hopp-shell-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeShell(body: string): string {
  const p = join(dir, 'sh');
  writeFileSync(p, '#!/bin/sh\n' + body + '\n');
  chmodSync(p, 0o755);
  return p;
}

describe('loginShellPath', () => {
  it('reads PATH from a login shell, ignoring what its startup files print', async () => {
    // The fake shell ignores its flags and runs the command it was given.
    const sh = fakeShell('echo "welcome banner"; PATH="/home/u/.local/bin:/usr/bin"; eval "$2"; echo trailing');
    // A generous bound: under load, starting a process can take seconds;
    // only the hanging shell below needs a short one.
    expect(await loginShellPath(sh, 15_000)).toBe('/home/u/.local/bin:/usr/bin');
  });

  it('gives up on a shell that hangs or fails', async () => {
    expect(await loginShellPath(fakeShell('sleep 10'), 300)).toBeUndefined();
    expect(await loginShellPath(fakeShell('exit 1'), 15_000)).toBeUndefined();
    expect(await loginShellPath(join(dir, 'missing'), 15_000)).toBeUndefined();
  });
});

describe('mergePath', () => {
  it('puts the login PATH first and keeps the rest, without duplicates', () => {
    expect(mergePath('/usr/bin:/bin', '/home/u/.local/bin:/usr/bin')).toBe('/home/u/.local/bin:/usr/bin:/bin');
    expect(mergePath('/usr/bin', undefined)).toBe('/usr/bin');
    expect(mergePath(undefined, '/a')).toBe('/a');
  });
});


describe('ensureUtf8Locale', () => {
  const eff = (e: NodeJS.ProcessEnv) => e['LC_ALL'] || e['LC_CTYPE'] || e['LANG'];
  it('gives an empty environment a UTF-8 locale', () => {
    const e: NodeJS.ProcessEnv = {};
    ensureUtf8Locale(e);
    expect(eff(e)).toBe('en_US.UTF-8');
    expect(e['LANG']).toBe('en_US.UTF-8');
  });
  it('leaves a UTF-8 locale alone', () => {
    const e: NodeJS.ProcessEnv = { LANG: 'ru_RU.UTF-8' };
    ensureUtf8Locale(e);
    expect(e).toEqual({ LANG: 'ru_RU.UTF-8' });
  });
  it('overrides a non-UTF-8 locale, LC_ALL included', () => {
    for (const e of [{ LANG: 'C' }, { LC_ALL: 'C', LANG: 'ru_RU.UTF-8' }, { LC_CTYPE: 'POSIX' }] as NodeJS.ProcessEnv[]) {
      ensureUtf8Locale(e);
      expect(eff(e)).toMatch(/UTF-8/);
    }
  });
});

describe('the remembered PATH', () => {
  it('round-trips, creating its folder', () => {
    const f = join(dir, 'deep', 'login-path');
    expect(readPathCache(f)).toBeUndefined();
    writePathCache(f, '/a/bin:/b/bin');
    expect(readPathCache(f)).toBe('/a/bin:/b/bin');
  });
  it('ignores an empty or multi-line file', () => {
    const f = join(dir, 'login-path');
    writeFileSync(f, '\n');
    expect(readPathCache(f)).toBeUndefined();
    writeFileSync(f, '/a\n/b\n');
    expect(readPathCache(f)).toBeUndefined();
  });
});
