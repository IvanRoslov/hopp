import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginShellPath, mergePath } from './shellEnv';

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
    expect(await loginShellPath(sh, 2000)).toBe('/home/u/.local/bin:/usr/bin');
  });

  it('gives up on a shell that hangs or fails', async () => {
    expect(await loginShellPath(fakeShell('sleep 10'), 300)).toBeUndefined();
    expect(await loginShellPath(fakeShell('exit 1'), 2000)).toBeUndefined();
    expect(await loginShellPath(join(dir, 'missing'), 2000)).toBeUndefined();
  });
});

describe('mergePath', () => {
  it('puts the login PATH first and keeps the rest, without duplicates', () => {
    expect(mergePath('/usr/bin:/bin', '/home/u/.local/bin:/usr/bin')).toBe('/home/u/.local/bin:/usr/bin:/bin');
    expect(mergePath('/usr/bin', undefined)).toBe('/usr/bin');
    expect(mergePath(undefined, '/a')).toBe('/a');
  });
});
