// ShellStore keeps what the daemon cannot know: projects, tasks and
// long-lived agents, in <HOPP_HOME>/shell/state.json. Every change is one
// atomic write (temp file, fsync, rename) and is announced to listeners. The
// state before each write is kept in state.json.bak; when state.json cannot
// be read (an empty file after a crash, a corrupt one) the store falls back
// to the .bak, says so in `recovered`, and on its next write moves the broken
// file to state.json.broken. A file from a newer app is never overwritten.
//
// More than one process may use the same store: the app, and `hopp task`
// run while the app is closed. Every change takes the lock file
// state.lock and starts from the file on disk, so no write is lost; a read
// notices when another process changed the file and reads it again, and
// watch() announces such a change to the listeners.
import { unwatchFile, watchFile } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShellState } from '../../shared/shell';
import { withFileLock } from './lock';

export const STORE_VERSION = 1;

interface FileShape extends ShellState {
  version: number;
  // Names of one-time seeds already applied (see seedOnce).
  seeded?: string[];
}

const empty = (): ShellState => ({ projects: [], pipelines: [], tasks: [], agents: [] });

export class ShellStore {
  readonly path: string;
  private state: ShellState | null = null;
  private seeded: string[] = [];
  // Set when the state was read from state.json.bak: what happened.
  recovered: string | null = null;
  private brokenPending = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: ShellState) => void>();
  // What state.json looked like when this process last read or wrote it,
  // and when its listeners were last told.
  private sig = '';
  private toldSig = '';

  constructor(readonly home: string) {
    this.path = join(home, 'shell', 'state.json');
  }

  get lockPath(): string {
    return join(this.home, 'shell', 'state.lock');
  }

  // read returns a copy of the current state.
  async read(): Promise<ShellState> {
    return structuredClone(await this.load());
  }

  // watch announces changes another process made to the file; it returns
  // the function that stops watching.
  watch(intervalMs = 500): () => void {
    const check = () => {
      void this.refresh().catch((err) => console.warn('hopp: could not re-read the store: ' + (err as Error).message));
    };
    watchFile(this.path, { interval: intervalMs }, check);
    return () => unwatchFile(this.path, check);
  }

  // refresh runs in the queue of changes, so what it announces is never
  // older than a change of this process.
  private refresh(): Promise<void> {
    const run = async () => {
      // A read may have loaded the change already: what counts is whether
      // the listeners have heard of it.
      if (!this.state || (await this.fileSig()) === this.toldSig) return;
      const next = await this.load();
      this.toldSig = this.sig;
      this.announce(next);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private announce(s: ShellState): void {
    for (const cb of this.listeners) {
      try {
        cb(structuredClone(s));
      } catch {
        // A listener's failure is not the store's.
      }
    }
  }

  private async fileSig(): Promise<string> {
    try {
      const st = await stat(this.path);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  }

  onChanged(cb: (s: ShellState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // update runs fn on a copy of the state, one update at a time; when fn
  // returns, the copy is written and becomes the state. When fn throws,
  // nothing changes.
  update<T>(fn: (s: ShellState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await mkdir(join(this.home, 'shell'), { recursive: true });
      const { out, next } = await withFileLock(this.lockPath, async () => {
        // Under the lock: start from the file, whoever wrote it last.
        this.state = null;
        const next = structuredClone(await this.load());
        const out = await fn(next);
        await this.write(next);
        this.state = next;
        this.sig = await this.fileSig();
        this.toldSig = this.sig;
        return { out, next };
      });
      this.announce(next);
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // seedOnce runs fn once per key over the store's whole life: after it ran
  // (even if the human later removed what it added) it never runs again.
  async seedOnce(key: string, fn: (s: ShellState) => void): Promise<boolean> {
    await this.load();
    if (this.seeded.includes(key)) return false;
    let ran = false;
    await this.update((s) => {
      if (this.seeded.includes(key)) return;
      fn(s);
      this.seeded = [...this.seeded, key];
      ran = true;
    });
    return ran;
  }

  private async load(): Promise<ShellState> {
    if (this.state) {
      if ((await this.fileSig()) === this.sig) return this.state;
      this.state = null; // another process changed it
    }
    const sig = await this.fileSig();
    let raw: Partial<FileShape>;
    try {
      raw = await this.parse(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = empty();
        this.seeded = [];
        this.sig = 'none';
        if (!this.toldSig) this.toldSig = 'none';
        return this.state;
      }
      if (err instanceof NewerFile) throw err;
      const bak = this.path + '.bak';
      try {
        raw = await this.parse(bak);
      } catch (bakErr) {
        if (bakErr instanceof NewerFile) throw bakErr;
        throw new Error(
          `${this.path} cannot be read (${(err as Error).message}) and neither can ${bak}; move both away to start with an empty app`,
        );
      }
      this.recovered = `${this.path} could not be read (${(err as Error).message}); the app uses ${bak}, the state before the last change`;
      this.brokenPending = true;
      console.warn('hopp: ' + this.recovered);
    }
    const state: ShellState = {
      projects: raw.projects ?? [],
      pipelines: raw.pipelines ?? [],
      tasks: (raw.tasks ?? []).map((t) => ({ ...t, pipeline: t.pipeline ?? null, base: t.base ?? null, startedBy: t.startedBy ?? null, addedWorkerProfiles: t.addedWorkerProfiles ?? [] })),
      agents: raw.agents ?? [],
    };
    this.seeded = Array.isArray(raw.seeded) ? raw.seeded.filter((x) => typeof x === 'string') : [];
    this.state = state;
    this.sig = sig;
    if (!this.toldSig) this.toldSig = sig; // the first read: nothing to tell
    return state;
  }

  // parse reads one state file; ENOENT passes through, anything unreadable
  // is an Error saying why.
  private async parse(path: string): Promise<Partial<FileShape>> {
    const text = await readFile(path, 'utf8');
    if (!text.trim()) throw new Error('the file is empty');
    let raw: Partial<FileShape>;
    try {
      raw = JSON.parse(text) as Partial<FileShape>;
    } catch {
      throw new Error('not valid JSON');
    }
    if (typeof raw.version !== 'number') throw new Error('no version');
    if (raw.version > STORE_VERSION) {
      throw new NewerFile(`${path} was written by a newer hopp app (version ${raw.version}); update the app`);
    }
    return raw;
  }

  private async write(s: ShellState): Promise<void> {
    const dir = join(this.home, 'shell');
    await mkdir(dir, { recursive: true });
    const body: FileShape = { version: STORE_VERSION, seeded: this.seeded, ...s };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const f = await open(tmp, 'w', 0o600);
    try {
      await f.writeFile(JSON.stringify(body, null, 2) + '\n');
      await f.sync();
    } finally {
      await f.close();
    }
    try {
      if (this.brokenPending) {
        await rename(this.path, this.path + '.broken').catch(() => undefined);
        this.brokenPending = false;
      } else {
        // The state before this change; a copy, so state.json is never missing.
        await copyFile(this.path, this.path + '.bak').catch(() => undefined);
      }
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    const d = await open(dir, 'r').catch(() => null);
    await d?.sync().catch(() => undefined);
    await d?.close();
  }
}

class NewerFile extends Error {}
