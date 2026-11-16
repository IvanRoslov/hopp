import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon } from './start';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hopp-start-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeHopp(body: string) {
  const p = join(dir, 'hopp');
  writeFileSync(p, '#!/bin/sh\n' + body + '\n');
  chmodSync(p, 0o755);
}

describe('startDaemon', () => {
  it('runs `hopp daemon start` from PATH with the app environment', async () => {
    fakeHopp(`echo "$@" > "${dir}/args"; echo "home=$HOPP_HOME" >> "${dir}/args"; echo daemon started`);
    const r = await startDaemon({ PATH: dir, HOPP_HOME: '/x/home' }, []);
    expect(r).toEqual({ ok: true, message: 'daemon started' });
    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe('daemon start\nhome=/x/home\n');
  });

  it('says when hopp is not found', async () => {
    const r = await startDaemon({ PATH: dir }, []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hopp was not found on PATH/);
  });

  it('reports a failed start with its output', async () => {
    fakeHopp('echo "cannot start: boom" >&2; exit 1');
    const r = await startDaemon({ PATH: dir }, []);
    expect(r).toEqual({ ok: false, message: 'cannot start: boom' });
  });
});
