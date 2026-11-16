// ShellStore keeps what the daemon cannot know: projects, tasks and
// long-lived agents, in <HOPP_HOME>/shell/state.json. Every change is one
// atomic write (temp file + rename) and is announced to listeners. A file it
// cannot read (corrupt, or from a newer app) is never overwritten.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShellState } from '../../shared/shell';

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
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: ShellState) => void>();

  constructor(readonly home: string) {
    this.path = join(home, 'shell', 'state.json');
  }

  // read returns a copy of the current state.
  async read(): Promise<ShellState> {
    return structuredClone(await this.load());
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
      const next = structuredClone(await this.load());
      const out = await fn(next);
      await this.write(next);
      this.state = next;
      for (const cb of this.listeners) {
        try {
          cb(structuredClone(next));
        } catch {
          // A listener's failure is not the store's.
        }
      }
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
    if (this.state) return this.state;
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = empty();
        return this.state;
      }
      throw err;
    }
    let raw: Partial<FileShape>;
    try {
      raw = JSON.parse(text) as Partial<FileShape>;
    } catch {
      throw new Error(`${this.path} is not valid JSON; fix or move it away`);
    }
    if (typeof raw.version !== 'number') throw new Error(`${this.path} has no version; fix or move it away`);
    if (raw.version > STORE_VERSION) {
      throw new Error(`${this.path} was written by a newer hopp app (version ${raw.version}); update the app`);
    }
    const state: ShellState = {
      projects: raw.projects ?? [],
      pipelines: raw.pipelines ?? [],
      tasks: (raw.tasks ?? []).map((t) => ({ ...t, pipeline: t.pipeline ?? null })),
      agents: raw.agents ?? [],
    };
    this.seeded = Array.isArray(raw.seeded) ? raw.seeded.filter((x) => typeof x === 'string') : [];
    this.state = state;
    return state;
  }

  private async write(s: ShellState): Promise<void> {
    await mkdir(join(this.home, 'shell'), { recursive: true });
    const body: FileShape = { version: STORE_VERSION, seeded: this.seeded, ...s };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
