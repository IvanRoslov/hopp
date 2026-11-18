// withFileLock runs fn while holding a lock file, so two processes (the app
// and a `hopp task` run while the app is closed, or two such runs) never
// interleave their writes of the same store. The lock file holds the
// holder's pid and a random token; a lock whose holder is no longer alive,
// or that is older than STALE_MS, is broken.
import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';

const STALE_MS = 10 * 60_000;

export class LockTimeout extends Error {}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryTake(path: string, body: string): Promise<boolean> {
  try {
    const f = await open(path, 'wx', 0o600);
    try {
      await f.writeFile(body);
    } finally {
      await f.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

// breakIfStale removes the lock when its holder is gone. The lock is first
// renamed to a name of our own (atomic), so of two processes breaking the
// same stale lock only one removes it; a lock taken fresh in between is put
// back.
async function breakIfStale(path: string): Promise<void> {
  let text: string;
  let mtime: number;
  try {
    [text, mtime] = await Promise.all([readFile(path, 'utf8'), stat(path).then((s) => s.mtimeMs)]);
  } catch {
    return; // gone already: the next try takes it
  }
  const pid = Number(text.split(' ')[0]);
  const stale = !Number.isInteger(pid) || pid <= 0 || !alive(pid) || Date.now() - mtime > STALE_MS;
  if (!stale) return;
  const aside = `${path}.break-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch {
    return;
  }
  const moved = await readFile(aside, 'utf8').catch(() => '');
  if (moved !== text) {
    // Someone took the lock between our read and our rename: give it back,
    // unless yet another process holds the path by now (link never replaces).
    await link(aside, path).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return;
  }
  await unlink(aside).catch(() => undefined);
}

// KeyedQueue runs the calls of one key one at a time, in the order they
// came; calls of different keys do not wait for each other.
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return p;
  }
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const token = randomBytes(8).toString('hex');
  const body = `${process.pid} ${token}\n`;
  const deadline = Date.now() + timeoutMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    if (await tryTake(path, body)) break;
    await breakIfStale(path);
    if (Date.now() > deadline) {
      const holder = (await readFile(path, 'utf8').catch(() => '')).split(' ')[0] || 'unknown';
      throw new LockTimeout(`${path} is held by process ${holder} for more than ${Math.round(timeoutMs / 1000)} s`);
    }
    await sleep(wait);
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock.
    if ((await readFile(path, 'utf8').catch(() => '')) === body) await unlink(path).catch(() => undefined);
  }
}
