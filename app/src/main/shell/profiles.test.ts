import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeProfile, makeSession } from '../../../test/fakeDaemon';
import { DaemonClient } from '../daemon/client';
import { makeRunner } from './exec';
import { importProfileName, uniqueProfileName } from './profiles';
import { ShellService } from './service';
import { ShellStore } from './store';

let root: string;
let d: FakeDaemon;
let svc: ShellService;
let changes: number;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-prof-')));
  d = new FakeDaemon(join(root, 'daemon'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('sonnet', { agent: 'claude-code', model: 'claude-sonnet-5-5', position: 0 }), makeProfile('cheap', { agent: 'deepseek', model: 'deepseek-flash[1m]', position: 1 })];
  d.defaultProfile = 'sonnet';
  svc = new ShellService({
    home: join(root, 'home'), store: new ShellStore(join(root, 'home')), client: new DaemonClient(d.socketPath),
    git: makeRunner('git', () => process.env), hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null,
  });
  changes = 0;
  svc.onProfilesChanged(() => changes++);
});
afterEach(async () => {
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

const cat = (agent: string, models: [string, boolean][], warning = '') => ({
  agent, source: 'cli', warning, models: models.map(([id, main]) => ({ id, name: id.toUpperCase(), description: main ? 'about ' + id : '', main, efforts: [] })),
});

describe('profile names, as rocket made them', () => {
  it('derives names per harness', () => {
    expect(importProfileName('claude-code', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(importProfileName('codex', 'gpt-6.sol')).toBe('codex-gpt-6-sol');
    expect(importProfileName('kimi-code', 'kimi-code/kimi-k3')).toBe('kimi-k3');
    expect(importProfileName('kimi-code', 'kimi-code/k3-turbo')).toBe('kimi-k3-turbo');
    expect(importProfileName('pi', 'deepseek/deepseek-flash')).toBe('pi-deepseek-flash');
    expect(importProfileName('deepseek', 'deepseek-flash[1m]')).toBe('deepseek-flash-1m');
    expect(importProfileName('agy', 'gemini-3.8-flash-low')).toBe('agy-gemini-3-8-flash-low');
    expect(importProfileName('agy', 'claude-opus-5-5-high')).toBe('agy-claude-opus-5-5-high');
    expect(uniqueProfileName('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(uniqueProfileName('x'.repeat(45), new Set(['x'.repeat(40)]))).toBe('x'.repeat(38) + '-2');
  });
});

describe('listing and editing', () => {
  it('lists disabled profiles too, enabled first, and marks the default', async () => {
    d.profiles.push(makeProfile('off', { enabled: false, position: 2 }));
    const l = await svc.listProfiles();
    expect(l.map((p) => [p.name, p.enabled, !!p.isDefault])).toEqual([['sonnet', true, true], ['cheap', true, false], ['off', false, false]]);
  });

  it('switches a profile off and on, and tells listeners', async () => {
    expect((await svc.setProfileEnabled('cheap', false)).ok).toBe(true);
    expect(d.profiles.find((p) => p.name === 'cheap')!.enabled).toBe(false);
    expect((await svc.setProfileEnabled('cheap', true)).ok).toBe(true);
    expect(changes).toBe(2);
  });

  it('refuses to switch off the default profile, and says what to do', async () => {
    const r = await svc.setProfileEnabled('sonnet', false);
    expect(!r.ok && r.error.code).toBe('profile_is_default');
    expect(!r.ok && r.error.message).toContain('make another profile the default');
    expect(d.profiles[0]!.enabled).toBe(true);
    expect((await svc.setDefaultProfile('cheap')).ok).toBe(true);
    expect((await svc.setProfileEnabled('sonnet', false)).ok).toBe(true);
    expect(changes).toBe(2);
  });

  it('a remembered choice that was switched off cannot launch a task', async () => {
    await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
    await svc.setProfileEnabled('cheap', false);
    const r = await svc.createTask({ projectSlug: 'site', brief: 'x', orchestratorProfile: 'cheap', workerProfiles: [] });
    expect(!r.ok && r.error.field).toBe('orchestratorProfile');
    const w = await svc.createTask({ projectSlug: 'site', brief: 'x', orchestratorProfile: 'sonnet', workerProfiles: ['cheap'] });
    expect(!w.ok && w.error.field).toBe('workerProfiles');
  });

  it('updates a description and keeps what was not given', async () => {
    const r = await svc.updateProfile('cheap', { description: 'Дёшево и быстро\nдля мелочей' });
    expect(r.ok && r.value).toMatchObject({ description: 'Дёшево и быстро\nдля мелочей', model: 'deepseek-flash[1m]' });
  });

  it('moves a profile', async () => {
    d.profiles.push(makeProfile('third', { position: 2 }));
    expect((await svc.moveProfile('third', 0)).ok).toBe(true);
    expect([...d.profiles].sort((a, b) => a.position - b.position).map((p) => p.name)).toEqual(['third', 'sonnet', 'cheap']);
    expect((await svc.moveProfile('ghost', 0)).ok).toBe(false);
  });

  it('refuses to remove a profile a running session or an active task uses', async () => {
    d.sessions.push(makeSession('s1', { profile: 'cheap' }));
    let r = await svc.removeProfile('cheap');
    expect(!r.ok && r.error).toMatchObject({ code: 'profile_in_use' });
    expect(!r.ok && r.error.message).toContain('session s1');
    d.sessions[0]!.state = 'done';
    await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
    const t = await svc.createTask({ projectSlug: 'site', brief: 'Fix it', orchestratorProfile: 'sonnet', workerProfiles: ['cheap'] });
    expect(t.ok).toBe(true);
    d.sessions.forEach((s) => (s.state = 'done'));
    r = await svc.removeProfile('cheap');
    expect(!r.ok && r.error.message).toContain('task "Fix it"');
    if (t.ok) await svc.finishTask(t.value.id);
    expect((await svc.removeProfile('cheap')).ok).toBe(true);
    expect(d.profiles.map((p) => p.name)).toEqual(['sonnet']);
  });
});

describe('catalog and import', () => {
  beforeEach(() => {
    d.catalogs = [
      cat('claude-code', [['claude-sonnet-5-5', true], ['claude-opus-5-5', true], ['claude-old', false]]),
      cat('codex', [], 'codex is not installed'),
      cat('deepseek', [['deepseek-flash[1m]', true], ['deepseek-v4-pro', true]]),
    ];
  });

  it('marks models that have a profile', async () => {
    const r = await svc.modelCatalog();
    expect(r.ok && r.value[0]!.models.map((m) => [m.id, m.known])).toEqual([['claude-sonnet-5-5', true], ['claude-opus-5-5', false], ['claude-old', false]]);
    expect(r.ok && r.value[1]).toMatchObject({ agent: 'codex', warning: 'codex is not installed', models: [] });
  });

  it('adds a switched-off profile per new current model, reports the harness that failed, and adds nothing the second time', async () => {
    const r = await svc.importModels();
    expect(r.ok && r.value.added.map((p) => [p.name, p.agent, p.model, p.enabled, p.description])).toEqual([
      ['claude-opus-5-5', 'claude-code', 'claude-opus-5-5', false, 'about claude-opus-5-5'],
      ['deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro', false, 'about deepseek-v4-pro'],
    ]);
    expect(r.ok && r.value.failed).toEqual([{ agent: 'codex', reason: 'codex is not installed' }]);
    expect(r.ok && r.value.skipped).toBe(3);
    expect(changes).toBe(1);
    expect(d.profiles.find((p) => p.name === 'sonnet')!.description).toBe('');
    const again = await svc.importModels();
    expect(again.ok && again.value.added).toEqual([]);
  });

  it('a name already taken by another profile gets a suffix', async () => {
    d.profiles.push(makeProfile('claude-opus-5-5', { agent: 'pi', model: 'x/y' }));
    const r = await svc.importModels();
    expect(r.ok && r.value.added.map((p) => p.name)).toContain('claude-opus-5-5-2');
  });

  it('two imports at once add each model once', async () => {
    const [a, b] = await Promise.all([svc.importModels(), svc.importModels()]);
    expect((a.ok ? a.value.added.length : -1) + (b.ok ? b.value.added.length : -1)).toBe(2);
    expect(d.profiles.filter((p) => p.model === 'claude-opus-5-5')).toHaveLength(1);
  });
});

describe('names of a profile the human adds or copies', () => {
  it('newProfileName: the import name, the effort as a suffix, unique', async () => {
    const { newProfileName } = await import('./profiles');
    expect(newProfileName('kimi-code', 'kimi-code/kimi-k3-1-pro', '', new Set())).toBe('kimi-k3-1-pro');
    expect(newProfileName('kimi-code', 'kimi-code/kimi-k3-1-pro', 'max', new Set())).toBe('kimi-k3-1-pro-max');
    expect(newProfileName('codex', 'gpt-6.2', 'high', new Set(['codex-gpt-6-2-high']))).toBe('codex-gpt-6-2-high-2');
    expect(newProfileName('claude-code', 'Opus 5.6 Preview', '', new Set())).toBe('opus-5-6-preview');
  });

  it('copyProfileName: the effort in place of the source one, else -copy', async () => {
    const { copyProfileName } = await import('./profiles');
    expect(copyProfileName({ name: 'kimi-k3-1-pro', effort: '' }, 'max', new Set())).toBe('kimi-k3-1-pro-max');
    expect(copyProfileName({ name: 'kimi-k3-1-pro-max', effort: 'max' }, 'high', new Set())).toBe('kimi-k3-1-pro-high');
    expect(copyProfileName({ name: 'my-opus', effort: 'high' }, 'max', new Set())).toBe('my-opus-max');
    expect(copyProfileName({ name: 'kimi-k3-1-pro', effort: '' }, '', new Set(['kimi-k3-1-pro-copy']))).toBe('kimi-k3-1-pro-copy-2');
  });
});
