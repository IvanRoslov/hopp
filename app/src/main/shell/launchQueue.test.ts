// Slow git under a task launch: what waits for it. git is real, but a fetch
// (and, where a test says so, a worktree add) of a chosen clone waits on a
// gate the test opens. Nothing touches ~/.hopp or a real repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeProfile } from '../../../test/fakeDaemon';
import { RemoteShell } from '../../cli/connect';
import { DaemonClient } from '../daemon/client';
import { makeRunner, type Runner } from './exec';
import { serveShell, type ShellServer } from './server';
import { ShellService } from './service';
import { ShellStore } from './store';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const realGit = makeRunner('git', () => GIT_ENV);
const sh = (...a: string[]) => execFileSync('git', a, { env: GIT_ENV }).toString();

let root: string;
let home: string;
let d: FakeDaemon;
let svc: ShellService;
let server: ShellServer;
let remote: RemoteShell;
// Gates: a git call whose repository is a key waits until the gate opens.
let fetchGates: Map<string, Promise<void>>;
let worktreeGates: Map<string, Promise<void>>;
let gitLog: { repo: string; op: string; at: 'start' | 'end'; t: number }[];

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const slowGit: Runner = async (args, opts) => {
  const repo = args[0] === '-C' ? args[1]! : '';
  const op = args[0] === '-C' ? args.slice(2, 4).join(' ') : args.slice(0, 2).join(' ');
  gitLog.push({ repo, op, at: 'start', t: Date.now() });
  if (op.startsWith('fetch')) await fetchGates.get(repo);
  if (op === 'worktree add') await worktreeGates.get(repo);
  try {
    return await realGit(args, opts);
  } finally {
    gitLog.push({ repo, op, at: 'end', t: Date.now() });
  }
};

// managedClone: a bare "GitHub" repository with one commit, cloned where the
// app keeps managed clones.
function managedClone(name: string): string {
  const bare = join(root, 'github', name + '.git');
  mkdirSync(bare, { recursive: true });
  sh('-C', bare, 'init', '-q', '--bare', '-b', 'main');
  const work = mkdtempSync(join(root, 'seed-'));
  sh('clone', '-q', bare, work);
  sh('-C', work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  sh('-C', work, 'push', '-q', 'origin', 'HEAD:main');
  const clone = join(home, 'repos', 'ivan__' + name);
  sh('clone', '-q', bare, clone);
  return clone;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-launch-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'repos'), { recursive: true });
  d = new FakeDaemon(join(root, 'daemon'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('p')];
  fetchGates = new Map();
  worktreeGates = new Map();
  gitLog = [];
  svc = new ShellService({
    home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git: slowGit,
    hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null, now: () => 1000,
  });
  server = await serveShell(svc, join(root, 'shell.sock'));
  remote = new RemoteShell(server.path);
});
afterEach(async () => {
  await server.close();
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const clone = managedClone(name);
  const r = await svc.createProject({ name, description: '', orchestratorRepo: clone, workerRepos: [], guardrails: '' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return clone;
}

const task = (slug: string, brief = 'Fix it') =>
  remote.createTask({ projectSlug: slug, brief, orchestratorProfile: 'p', workerProfiles: [] });

// settled: whether p has settled within ms.
async function settled(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await new Promise((r) => setTimeout(r, ms));
  return done;
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the steps of a launch', () => {
  it('reach the CLI while the launch runs, then the answer', async () => {
    const site = await project('site');
    const g = gate();
    fetchGates.set(site, g.wait);
    const lines: string[] = [];
    const a = remote.createTask({ projectSlug: 'site', brief: 'Fix it', orchestratorProfile: 'p', workerProfiles: [] }, (l) => lines.push(l));
    await until(() => lines.length > 0);
    expect(lines).toEqual(['fetching the clone of the project from GitHub…']);
    g.open();
    const r = await a;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lines.slice(1).map((l) => l.replace(/\d+ s$/, 'N s'))).toEqual([
      'fetched in N s',
      `making the worktree ${r.value.dir} from origin/main…`,
      `starting the orchestrator ${r.value.id}…`,
    ]);
  });

  it('a refusal comes as the answer of a streamed launch', async () => {
    await project('site');
    const lines: string[] = [];
    const r = await remote.createTask({ projectSlug: 'ghost', brief: 'x', orchestratorProfile: 'p', workerProfiles: [] }, (l) => lines.push(l));
    expect(!r.ok && r.error.code).toBe('project_not_found');
    expect(lines).toEqual([]);
  });
});

describe('a slow fetch under a launch', () => {
  it('reads answer at once while a launch fetches', async () => {
    const site = await project('site');
    const g = gate();
    fetchGates.set(site, g.wait);
    const a = task('site');
    await until(() => gitLog.some((e) => e.repo === site && e.op.startsWith('fetch') && e.at === 'start'));
    const t0 = Date.now();
    const st = await remote.state();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(st.projects.map((p) => p.slug)).toEqual(['site']);
    g.open();
    expect((await a).ok).toBe(true);
  });

  it('a launch in another repository does not wait for the fetch', async () => {
    const site = await project('site');
    await project('docs');
    const g = gate();
    fetchGates.set(site, g.wait);
    const a = task('site');
    await until(() => gitLog.some((e) => e.repo === site && e.op.startsWith('fetch') && e.at === 'start'));
    const b = task('docs', 'Write it');
    const bDone = await settled(b, 3000);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(bDone, 'the launch in docs waited for the fetch of site').toBe(true);
    expect(ra.ok && rb.ok).toBe(true);
  });

  it('two launches in one clone get two ids and two worktrees, and never change the clone at the same time', async () => {
    const site = await project('site');
    const g = gate();
    fetchGates.set(site, g.wait);
    const a = task('site');
    const b = task('site');
    await until(() => gitLog.some((e) => e.repo === site && e.op.startsWith('fetch') && e.at === 'start'));
    await new Promise((r) => setTimeout(r, 200));
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(new Set([ra.value.id, rb.value.id]).size).toBe(2);
    expect(sh('-C', site, 'worktree', 'list').trim().split('\n')).toHaveLength(3);
    // The launch that came while the fetch ran took its result.
    expect(gitLog.filter((e) => e.repo === site && e.op.startsWith('fetch') && e.at === 'start')).toHaveLength(1);
    // No two git calls that change the clone ran at once.
    const writes = gitLog.filter((e) => e.repo === site && (e.op.startsWith('fetch') || e.op === 'worktree add'));
    let open = 0;
    for (const e of writes) {
      open += e.at === 'start' ? 1 : -1;
      expect(open).toBeLessThanOrEqual(1);
    }
  });
});
