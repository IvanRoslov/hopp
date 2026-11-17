// Profile writes against the real daemon, built from daemon/ and run on a
// temp HOPP_HOME and HOME with a PATH that holds no harness CLI, so no real
// account or config is reached. Skipped without Go.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '../daemon/client';
import { makeRunner } from './exec';
import { ShellService } from './service';
import { ShellStore } from './store';

const hasGo = spawnSync('go', ['version']).status === 0;

describe.skipIf(!hasGo)('model profiles against the real daemon', () => {
  let root: string;
  let daemon: ChildProcess;
  let svc: ShellService;
  let client: DaemonClient;
  let bin: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hpi-')));
    const home = join(root, 'h');
    mkdirSync(join(root, 'u'));
    bin = join(root, 'hopp');
    execFileSync('go', ['build', '-o', bin, './cmd/hopp'], { cwd: resolve(import.meta.dirname, '../../../../daemon'), stdio: 'ignore' });
    // A fresh program's first run waits for macOS to check it (seconds under
    // load); pay that here, not in the daemon's start below.
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 120_000 });
    env = { PATH: '/usr/bin:/bin', HOME: join(root, 'u'), HOPP_HOME: home, HOPP_SESSION_ID: '' };
    daemon = spawn(bin, ['daemon', 'run'], { env, stdio: 'ignore' });
    client = new DaemonClient(join(home, 'hopp.sock'));
    for (let i = 0; i < 100; i++) {
      try {
        await client.health();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    svc = new ShellService({
      home, store: new ShellStore(home), client, git: makeRunner('git', () => env),
      hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null,
    });
  }, 180_000);

  afterAll(async () => {
    daemon?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true });
  });

  it('a description with newlines and Cyrillic survives a round trip; switching, default, order', async () => {
    const before = await svc.listProfiles();
    expect(before.length).toBeGreaterThan(1);
    const def = before.find((p) => p.isDefault)!;
    const other = before.find((p) => !p.isDefault)!;
    const desc = 'Дёшево и быстро\nдля мелочей — «кавычки» и ёлки';
    const u = await svc.updateProfile(other.name, { description: desc });
    expect(u.ok && u.value.description).toBe(desc);
    expect((await svc.listProfiles()).find((p) => p.name === other.name)!.description).toBe(desc);

    const off = await svc.setProfileEnabled(def.name, false);
    expect(!off.ok && off.error.code).toBe('profile_is_default');
    expect((await svc.setProfileEnabled(other.name, true)).ok).toBe(true);
    expect((await svc.setDefaultProfile(other.name)).ok).toBe(true);
    expect((await svc.setProfileEnabled(def.name, false)).ok).toBe(true);
    const now = await svc.listProfiles();
    expect(now.find((p) => p.name === other.name)!.isDefault).toBe(true);
    expect(now.find((p) => p.name === def.name)!.enabled).toBe(false);

    const last = [...now].sort((a, b) => a.position - b.position).at(-1)!;
    expect((await svc.moveProfile(last.name, 0)).ok).toBe(true);
    const moved = [...(await svc.listProfiles())].sort((a, b) => a.position - b.position);
    expect(moved[0]!.name).toBe(last.name);
  });

  it('the catalog answers for every harness, and importing twice adds nothing the second time', async () => {
    const cat = await svc.modelCatalog();
    expect(cat.ok).toBe(true);
    if (!cat.ok) return;
    expect(cat.value.map((c) => c.agent).sort()).toEqual(['claude-code', 'codex', 'deepseek', 'kimi-code', 'pi']);
    const first = await svc.importModels();
    expect(first.ok).toBe(true);
    if (first.ok) for (const p of first.value.added) expect(p.enabled).toBe(false);
    const second = await svc.importModels();
    expect(second.ok && second.value.added).toEqual([]);
  });

  // In the same daemon (a separate file would build it again).
  it('lessons: an agent\'s CLI relabel and the app\'s sorting meet in the daemon\'s labels', async () => {
    const p = await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
    expect(p.ok).toBe(true);
    const id = Number(execFileSync(bin, ['lesson', 'crane needs DOCKER_CONFIG', '--label', 'hopp.about=hopp'], { env }).toString().trim());
    execFileSync(bin, ['lessons', 'label', String(id), 'hopp.about=project', 'hopp.project=site'], { env });
    const mine = await client.listLessons('new', { 'hopp.project': 'site', 'hopp.about': 'project' });
    expect(mine.map((l) => l.id)).toEqual([id]);
    expect(await svc.setLessonAbout(id, null)).toEqual({ ok: true, value: null });
    expect((await client.listLessons('new', { 'hopp.about': 'project' })).length).toBe(0);
    expect(await svc.setLessonAbout(id, 'project')).toEqual({ ok: true, value: null });
    expect(await svc.lessonToGuardrails(id)).toEqual({ ok: true, value: null });
    expect((await svc.state()).projects[0]!.guardrails).toBe(`- crane needs DOCKER_CONFIG (lesson #${id})`);
    expect((await client.listLessons('closed')).map((l) => l.id)).toEqual([id]);
    const full = execFileSync(bin, ['lessons', '--all', '--full', '--label', 'hopp.project=site'], { env }).toString();
    expect(full).toContain(`#${id}  closed`);
    expect(full).toContain('hopp.about=project');
  });
});
