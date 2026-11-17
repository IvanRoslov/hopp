import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockTimeout, withFileLock } from './lock';

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hopp-lock-'));
  lock = join(dir, 'state.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pid that surely ran and ended.
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

describe('withFileLock', () => {
  it('lets one holder in at a time and removes the lock after', async () => {
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(lock, async () => {
          inside++;
          most = Math.max(most, inside);
          await sleep(5);
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases on a throw', async () => {
    await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lock)).toBe(false);
  });

  it('breaks the lock of a process that is gone', async () => {
    writeFileSync(lock, `${deadPid()} abc\n`);
    expect(await withFileLock(lock, async () => 'in', 2000)).toBe('in');
  });

  it('waits for a live holder and gives up with a clear error', async () => {
    writeFileSync(lock, `${process.pid} someone-else\n`);
    await expect(withFileLock(lock, async () => 'in', 300)).rejects.toThrow(LockTimeout);
    await expect(withFileLock(lock, async () => 'in', 300)).rejects.toThrow(new RegExp(`held by process ${process.pid}`));
    // Never removed: it is not ours.
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid} someone-else\n`);
  });
});
