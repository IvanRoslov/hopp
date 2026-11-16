import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, ShellState } from '../../shared/shell';
import { ShellStore, STORE_VERSION } from './store';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hopp-store-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const project = (slug: string): Project => ({
  slug, name: slug, description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 1,
});

describe('ShellStore', () => {
  it('starts empty when there is no file and writes nothing until changed', async () => {
    const s = new ShellStore(home);
    expect(await s.read()).toEqual({ projects: [], pipelines: [], tasks: [], agents: [] });
    expect(() => readdirSync(join(home, 'shell'))).toThrow();
  });

  it('writes atomically, versioned, and reads back', async () => {
    const s = new ShellStore(home);
    await s.update((st) => {
      st.projects.push(project('a'));
    });
    const raw = JSON.parse(readFileSync(join(home, 'shell', 'state.json'), 'utf8'));
    expect(raw.version).toBe(STORE_VERSION);
    expect(raw.projects[0].slug).toBe('a');
    expect(readdirSync(join(home, 'shell'))).toEqual(['state.json']);
    const again = new ShellStore(home);
    expect((await again.read()).projects.map((p) => p.slug)).toEqual(['a']);
  });

  it('notifies listeners with the new state after every change', async () => {
    const s = new ShellStore(home);
    const seen: ShellState[] = [];
    const off = s.onChanged((st) => seen.push(st));
    await s.update((st) => {
      st.projects.push(project('a'));
    });
    await s.update((st) => {
      st.projects.push(project('b'));
    });
    off();
    await s.update((st) => {
      st.projects.push(project('c'));
    });
    expect(seen.map((x) => x.projects.length)).toEqual([1, 2]);
  });

  it('serializes concurrent updates', async () => {
    const s = new ShellStore(home);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((slug) =>
        s.update(async (st) => {
          await new Promise((r) => setTimeout(r, 5));
          st.projects.push(project(slug));
        }),
      ),
    );
    expect((await new ShellStore(home).read()).projects.map((p) => p.slug).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a failed update changes nothing and notifies no one', async () => {
    const s = new ShellStore(home);
    let n = 0;
    s.onChanged(() => n++);
    await expect(
      s.update((st) => {
        st.projects.push(project('a'));
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect((await s.read()).projects).toEqual([]);
    expect(n).toBe(0);
  });

  it('returns the value of the update function', async () => {
    const s = new ShellStore(home);
    expect(await s.update(() => 42)).toBe(42);
  });

  it('refuses a file from a newer version and does not overwrite it', async () => {
    mkdirSync(join(home, 'shell'));
    const p = join(home, 'shell', 'state.json');
    writeFileSync(p, JSON.stringify({ version: STORE_VERSION + 1, projects: [] }));
    const s = new ShellStore(home);
    await expect(s.read()).rejects.toThrow(/newer/);
    await expect(s.update(() => {})).rejects.toThrow(/newer/);
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe(STORE_VERSION + 1);
  });

  it('keeps the previous state in state.json.bak', async () => {
    const s = new ShellStore(home);
    await s.update((st) => {
      st.projects.push(project('a'));
    });
    await s.update((st) => {
      st.projects.push(project('b'));
    });
    const bak = JSON.parse(readFileSync(join(home, 'shell', 'state.json.bak'), 'utf8'));
    expect(bak.projects.map((p: Project) => p.slug)).toEqual(['a']);
    expect(readdirSync(join(home, 'shell')).sort()).toEqual(['state.json', 'state.json.bak']);
  });

  it('falls back to state.json.bak when state.json is empty or broken, and says so', async () => {
    const s = new ShellStore(home);
    await s.update((st) => {
      st.projects.push(project('a'));
    });
    await s.update((st) => {
      st.projects.push(project('b'));
    });
    for (const broken of ['', '{"version":1,"proj']) {
      writeFileSync(join(home, 'shell', 'state.json'), broken);
      const again = new ShellStore(home);
      expect((await again.read()).projects.map((p) => p.slug)).toEqual(['a']);
      expect(again.recovered).toMatch(/state\.json\.bak/);
    }
    // The next write repairs state.json and keeps the broken one aside.
    const again = new ShellStore(home);
    await again.update((st) => {
      st.projects.push(project('c'));
    });
    expect(JSON.parse(readFileSync(join(home, 'shell', 'state.json'), 'utf8')).projects.map((p: Project) => p.slug)).toEqual(['a', 'c']);
    expect(existsSync(join(home, 'shell', 'state.json.broken'))).toBe(true);
  });

  it('refuses to start, naming both files, when neither can be read', async () => {
    mkdirSync(join(home, 'shell'));
    writeFileSync(join(home, 'shell', 'state.json'), '{not json');
    writeFileSync(join(home, 'shell', 'state.json.bak'), '');
    await expect(new ShellStore(home).read()).rejects.toThrow(/state\.json.*state\.json\.bak/s);
  });

  it('refuses a corrupt file and never overwrites it', async () => {
    mkdirSync(join(home, 'shell'));
    writeFileSync(join(home, 'shell', 'state.json'), '{not json');
    const s = new ShellStore(home);
    await expect(s.read()).rejects.toThrow(/state\.json/);
    await expect(s.update(() => {})).rejects.toThrow(/state\.json/);
    expect(readFileSync(join(home, 'shell', 'state.json'), 'utf8')).toBe('{not json');
  });

  it('read returns a copy the caller cannot use to change the store', async () => {
    const s = new ShellStore(home);
    const st = await s.read();
    st.projects.push(project('x'));
    expect((await s.read()).projects).toEqual([]);
  });
});
