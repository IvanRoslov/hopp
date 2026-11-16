import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeLesson, makeProfile, makeSession } from '../../../test/fakeDaemon';
import type { ProjectInput, ShellState, TaskInput } from '../../shared/shell';
import { DaemonClient } from '../daemon/client';
import { makeRunner, RunError, type Runner } from './exec';
import { expandHome } from './projects';
import { ShellService, taskTitle, uniqueId } from './service';
import { ShellStore } from './store';

// Every test gets a temp HOPP_HOME, a fake daemon and throwaway git
// repositories in a temp folder. Nothing touches ~/.hopp or a real repository.
let root: string;
let home: string;
let d: FakeDaemon;
let store: ShellStore;
let svc: ShellService;
let hoppCalls: string[][];
let hoppFail: string | null;
let changes: ShellState[];

const git = makeRunner('git', () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }));

function mkRepo(name: string, commit = true): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const g = (...a: string[]) =>
    execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 't');
  if (commit) {
    writeFileSync(join(dir, 'README'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
  }
  return realpathSync(dir);
}

const branches = (repo: string) =>
  execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)']).toString().trim().split('\n').filter(Boolean);
const worktrees = (repo: string) =>
  execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain']).toString().split('\n').filter((l) => l.startsWith('worktree ')).length;

const fakeHopp: Runner = async (args) => {
  hoppCalls.push(args);
  if (hoppFail) throw new RunError(hoppFail);
  const key = args.join(' ');
  if (args[0] === 'tools' && args[1] === 'prompt') return { stdout: `## Tools\n\n- tool-for-${args[3]} — x\n`, stderr: '' };
  if (key === '--json tools list --all') {
    return { stdout: JSON.stringify({ tools: [{ name: 'fetcher', description: 'Fetch', via: 'command', command: ['curl'], mcp_server: '', harnesses: [], environment: [], paid: false, enabled: true, dir: '/t/fetcher' }], broken: [{ name: 'bad', error: 'tool.yaml: line 1: x' }] }), stderr: '' };
  }
  if (key === '--json tools show fetcher --all') return { stdout: JSON.stringify({ name: 'fetcher', usage: 'Run curl.\n' }), stderr: '' };
  if (key === '--json tools rules') {
    const p = join(home, 'tools', 'rules.md');
    return { stdout: JSON.stringify(existsSync(p) ? { text: readFileSync(p, 'utf8'), modified_at: 123 } : { text: '', modified_at: 0 }), stderr: '' };
  }
  if (args[0] === 'tools' && (args[1] === 'enable' || args[1] === 'disable')) {
    if (args[2] === 'ghost') throw new RunError('hopp: no tool ghost in the catalog');
    return { stdout: args[2] + '\n', stderr: '' };
  }
  throw new RunError('unexpected hopp call: ' + key);
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-shell-')));
  home = join(root, 'home');
  mkdirSync(home);
  d = new FakeDaemon(join(root, 'daemon'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [
    makeProfile('cheap', { agent: 'deepseek' }),
    makeProfile('off', { enabled: false }),
    makeProfile('sonnet', { agent: 'claude-code' }),
    makeProfile('codex', { agent: 'codex' }),
  ];
  hoppCalls = [];
  hoppFail = null;
  store = new ShellStore(home);
  changes = [];
  store.onChanged((s) => changes.push(s));
  svc = new ShellService({ home, store, client: new DaemonClient(d.socketPath), git, hopp: fakeHopp, pickFolder: async () => '/picked', now: () => 1000 });
});
afterEach(async () => {
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

const projectInput = (over: Partial<ProjectInput> = {}): ProjectInput => ({
  name: 'Site', description: 'The site', orchestratorRepo: null, workerRepos: [], guardrails: '', ...over,
});

async function project(over: Partial<ProjectInput> = {}) {
  const r = await svc.createProject(projectInput(over));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const taskInput = (over: Partial<TaskInput> = {}): TaskInput => ({
  projectSlug: 'site', brief: 'Fix the header\nIt overlaps the logo.', orchestratorProfile: 'sonnet', workerProfiles: ['cheap', 'codex'], ...over,
});

describe('projects', () => {
  it('creates a project with a slug from the name and tells listeners', async () => {
    const repo = mkRepo('site');
    mkdirSync(join(repo, 'sub'));
    const p = await project({ name: 'Наша Студия', orchestratorRepo: join(repo, 'sub'), guardrails: '  no force push ' });
    expect(p).toMatchObject({ slug: 'nasha-studiya', name: 'Наша Студия', orchestratorRepo: repo, guardrails: 'no force push', createdAt: 1000 });
    expect((await svc.state()).projects).toHaveLength(1);
    expect(changes.at(-1)!.projects[0]!.slug).toBe('nasha-studiya');
  });

  it('names the field of each error', async () => {
    const repo = mkRepo('site');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await project({ orchestratorRepo: repo });
    const cases: [Partial<ProjectInput>, string, string][] = [
      [{ name: '  ' }, 'name', 'name_required'],
      [{ name: 'site' }, 'name', 'name_taken'],
      [{ name: 'Other', slug: 'site' }, 'slug', 'slug_taken'],
      [{ name: 'Other', slug: '9lives' }, 'slug', 'slug_invalid'],
      [{ name: 'Other', slug: 'Bad Slug' }, 'slug', 'slug_invalid'],
      [{ name: 'Other', orchestratorRepo: join(root, 'missing') }, 'orchestratorRepo', 'folder_missing'],
      [{ name: 'Other', orchestratorRepo: 'relative/path' }, 'orchestratorRepo', 'folder_not_absolute'],
      [{ name: 'Other', orchestratorRepo: plain }, 'orchestratorRepo', 'not_a_git_repo'],
      [{ name: 'Other', orchestratorRepo: repo, workerRepos: [plain] }, 'workerRepos', 'not_a_git_repo'],
      [{ name: 'Other', workerRepos: [repo] }, 'orchestratorRepo', 'orchestrator_repo_required'],
    ];
    for (const [over, field, code] of cases) {
      const r = await svc.createProject(projectInput(over));
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) expect([r.error.field, r.error.code], JSON.stringify(over)).toEqual([field, code]);
    }
    expect((await svc.state()).projects).toHaveLength(1);
  });

  it('accepts a repository written with ~ and expands it', async () => {
    expect(expandHome('~/projects/site', '/Users/u')).toBe('/Users/u/projects/site');
    expect(expandHome('~', '/Users/u')).toBe('/Users/u');
    expect(expandHome('/abs/~x', '/Users/u')).toBe('/abs/~x');
    const fake = await svc.createProject(projectInput({ name: 'Other', orchestratorRepo: '~/surely-not-a-folder-hopp' }));
    expect(!fake.ok && fake.error).toMatchObject({ code: 'folder_missing', field: 'orchestratorRepo' });
    const agent = await svc.createAgent({ name: 'ops', profile: 'sonnet', dir: '~/surely-not-a-folder-hopp' });
    expect(!agent.ok && agent.error.code).toBe('folder_missing');
  });

  it('updates a project, keeps createdAt, and locks the slug once it has tasks', async () => {
    await project();
    const r = await svc.updateProject('site', projectInput({ description: 'New', slug: 'web' }));
    expect(r.ok && r.value).toMatchObject({ slug: 'web', description: 'New', createdAt: 1000 });
    await svc.createTask(taskInput({ projectSlug: 'web' }));
    const locked = await svc.updateProject('web', projectInput({ slug: 'other' }));
    expect(!locked.ok && locked.error).toMatchObject({ code: 'slug_locked', field: 'slug' });
    const same = await svc.updateProject('web', projectInput({ name: 'Site', slug: 'web', description: 'again' }));
    expect(same.ok).toBe(true);
    expect((await svc.updateProject('nope', projectInput())).ok).toBe(false);
  });

  it('refuses to remove a project with tasks in the list', async () => {
    await project();
    const t = await svc.createTask(taskInput());
    expect(t.ok).toBe(true);
    const r = await svc.removeProject('site');
    expect(!r.ok && r.error.code).toBe('project_has_tasks');
    if (t.ok) {
      await svc.finishTask(t.value.id);
      await svc.hideTask(t.value.id);
    }
    expect((await svc.removeProject('site')).ok).toBe(true);
    expect((await svc.state()).projects).toEqual([]);
  });

  it('pickFolder asks the dialog', async () => {
    expect(await svc.pickFolder()).toBe('/picked');
  });
});

describe('profiles', () => {
  it('lists enabled profiles first, each group in the daemon order', async () => {
    expect((await svc.listProfiles()).map((p) => p.name)).toEqual(['cheap', 'sonnet', 'codex', 'off']);
  });
});

describe('task launch', () => {
  it('makes a worktree, writes the start texts and launches the orchestrator', async () => {
    const repo = mkRepo('site');
    const api = mkRepo('api');
    await project({ orchestratorRepo: repo, workerRepos: [api], guardrails: 'Be careful.' });
    const r = await svc.createTask(taskInput({ extraSystemPrompt: 'Prefer small commits.' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value;
    const dir = join(home, 'worktrees', 'site', 'fix-the-header');
    expect(t).toMatchObject({
      id: 'fix-the-header', sessionId: 'fix-the-header', title: 'Fix the header', dir, branch: 'hopp/fix-the-header',
      projectSlug: 'site', orchestratorProfile: 'sonnet', workerProfiles: ['cheap', 'codex'], status: 'active', hidden: false,
    });
    expect(existsSync(join(dir, 'README'))).toBe(true);
    expect(branches(repo)).toContain('hopp/fix-the-header');

    const body = d.created.at(-1)!;
    expect(body).toMatchObject({
      id: 'fix-the-header', dir, profile: 'sonnet', message: 'Fix the header\nIt overlaps the logo.',
      labels: { 'hopp.project': 'site', 'hopp.task': 'fix-the-header', 'hopp.role': 'orchestrator' },
    });
    expect(body['spawn_dirs']).toEqual([repo, api, join(home, 'worktrees', 'site'), dir]);
    const sp = String(body['system_prompt']);
    const texts = join(home, 'shell', 'tasks', 'fix-the-header');
    expect(sp).toContain('# Your role: orchestrator');
    expect(sp).toContain('Be careful.');
    expect(sp).toContain('- tool-for-claude-code');
    expect(sp).toContain('Prefer small commits.');
    expect(sp).toContain(`\`cheap\` (deepseek): \`--system-prompt-file ${join(texts, 'worker-deepseek.md')}\``);
    expect(sp).toContain(`\`codex\` (codex): \`--system-prompt-file ${join(texts, 'worker-codex.md')}\``);
    const w = readFileSync(join(texts, 'worker-deepseek.md'), 'utf8');
    expect(w).toContain('# Your role: worker');
    expect(w).toContain('- tool-for-deepseek');
    expect(readFileSync(join(texts, 'worker-codex.md'), 'utf8')).toContain('- tool-for-codex');
    expect(readFileSync(join(texts, 'orchestrator.md'), 'utf8')).toBe(sp);
    expect((await svc.state()).tasks.map((x) => x.id)).toEqual(['fix-the-header']);
  });

  it('without a repository makes a plain folder', async () => {
    await project();
    const r = await svc.createTask(taskInput({ title: 'Write copy' }));
    expect(r.ok && r.value).toMatchObject({ id: 'write-copy', branch: null, dir: join(home, 'work', 'site', 'write-copy') });
    expect(existsSync(join(home, 'work', 'site', 'write-copy'))).toBe(true);
    expect(d.created.at(-1)!['spawn_dirs']).toEqual([join(home, 'worktrees', 'site'), join(home, 'work', 'site', 'write-copy')]);
  });

  it('with no worker profiles lets workers use the orchestrator profile', async () => {
    await project();
    const r = await svc.createTask(taskInput({ workerProfiles: [] }));
    expect(r.ok && r.value.workerProfiles).toEqual(['sonnet']);
  });

  it('makes the session id unique against sessions, tasks, mailboxes, folders and branches', async () => {
    const repo = mkRepo('site');
    await project({ orchestratorRepo: repo });
    d.sessions.push(makeSession('fix-the-header', { state: 'done' }));
    d.mailboxes.push({ name: 'fix-the-header-2', unread: 0, total: 0 });
    execFileSync('git', ['-C', repo, 'branch', 'hopp/fix-the-header-3']);
    mkdirSync(join(home, 'worktrees', 'site', 'fix-the-header-4'), { recursive: true });
    const r = await svc.createTask(taskInput());
    expect(r.ok && r.value.id).toBe('fix-the-header-5');
    const again = await svc.createTask(taskInput());
    expect(again.ok && again.value.id).toBe('fix-the-header-6');
  });

  it('two launches at once get two ids', async () => {
    const repo = mkRepo('site');
    await project({ orchestratorRepo: repo });
    const [a, b] = await Promise.all([svc.createTask(taskInput()), svc.createTask(taskInput())]);
    expect([a.ok && a.value.id, b.ok && b.value.id]).toEqual(['fix-the-header', 'fix-the-header-2']);
    expect(branches(repo).sort()).toEqual(['hopp/fix-the-header', 'hopp/fix-the-header-2', 'main']);
  });

  it('uses the session name from More, made unique, and checks it', async () => {
    await project();
    const r = await svc.createTask(taskInput({ sessionName: 'hdr' }));
    expect(r.ok && r.value.id).toBe('hdr');
    const r2 = await svc.createTask(taskInput({ sessionName: 'hdr' }));
    expect(r2.ok && r2.value.id).toBe('hdr-2');
    const bad = await svc.createTask(taskInput({ sessionName: 'Bad name' }));
    expect(!bad.ok && bad.error).toMatchObject({ code: 'session_name_invalid', field: 'sessionName' });
  });

  it('names the field of a bad input and makes nothing', async () => {
    await project();
    const cases: [Partial<TaskInput>, string][] = [
      [{ projectSlug: 'nope' }, 'projectSlug'],
      [{ brief: '  ' }, 'brief'],
      [{ orchestratorProfile: 'off' }, 'orchestratorProfile'],
      [{ orchestratorProfile: 'ghost' }, 'orchestratorProfile'],
      [{ workerProfiles: ['cheap', 'off'] }, 'workerProfiles'],
    ];
    for (const [over, field] of cases) {
      const r = await svc.createTask(taskInput(over));
      expect(!r.ok && r.error.field, JSON.stringify(over)).toBe(field);
    }
    expect(d.created).toEqual([]);
    expect(existsSync(join(home, 'work'))).toBe(false);
  });

  it('removes the worktree and branch it made when the daemon refuses, and only those', async () => {
    const repo = mkRepo('site');
    execFileSync('git', ['-C', repo, 'branch', 'keep-me']);
    await project({ orchestratorRepo: repo });
    d.override.set('POST /v1/sessions', { status: 400, body: { error: { code: 'dir_not_allowed', message: 'nope' } } });
    const r = await svc.createTask(taskInput());
    expect(!r.ok && r.error).toMatchObject({ code: 'dir_not_allowed', message: 'nope' });
    expect(branches(repo).sort()).toEqual(['keep-me', 'main']);
    expect(worktrees(repo)).toBe(1);
    expect(existsSync(join(home, 'worktrees', 'site', 'fix-the-header'))).toBe(false);
    expect(existsSync(join(home, 'shell', 'tasks', 'fix-the-header'))).toBe(false);
    expect((await svc.state()).tasks).toEqual([]);
  });

  it('removes the plain folder it made when the daemon is down', async () => {
    await project();
    await d.stop();
    const r = await svc.createTask(taskInput());
    expect(!r.ok && r.error.code).toBe('daemon_unavailable');
    expect(existsSync(join(home, 'work', 'site', 'fix-the-header'))).toBe(false);
    await d.start();
    d.override.set('POST /v1/sessions', { status: 503, body: { error: { code: 'unavailable', message: 'busy' } } });
    const r2 = await svc.createTask(taskInput());
    expect(!r2.ok && r2.error.code).toBe('unavailable');
    expect(existsSync(join(home, 'work', 'site', 'fix-the-header'))).toBe(false);
  });

  it('makes nothing when the tool catalog cannot be read', async () => {
    const repo = mkRepo('site');
    await project({ orchestratorRepo: repo });
    hoppFail = 'hopp: command not found';
    const r = await svc.createTask(taskInput());
    expect(!r.ok && r.error.code).toBe('command_failed');
    expect(!r.ok && r.error.message).toContain('hopp tools prompt');
    expect(branches(repo)).toEqual(['main']);
    expect(d.created).toEqual([]);
  });

  it('reports a git failure and leaves nothing behind', async () => {
    const empty = mkRepo('empty', false);
    await project({ orchestratorRepo: empty });
    const r = await svc.createTask(taskInput());
    expect(!r.ok && r.error.code).toBe('command_failed');
    expect(branches(empty)).toEqual([]);
    expect(existsSync(join(home, 'shell', 'tasks', 'fix-the-header'))).toBe(false);
    expect(d.created).toEqual([]);
  });

  it('title and id helpers', async () => {
    expect(taskTitle({ brief: '  ' + 'a'.repeat(70) + '\nmore' })).toBe('a'.repeat(60));
    expect(taskTitle({ title: ' Given ', brief: 'x' })).toBe('Given');
    const long = 'x'.repeat(45);
    expect(await uniqueId(long, (c) => c === 'x'.repeat(40))).toBe('x'.repeat(38) + '-2');
    expect(await uniqueId('a-b-', () => false)).toBe('a-b');
  });

  it('a brief that slugifies to nothing still gets an id', async () => {
    await project();
    const r = await svc.createTask(taskInput({ brief: '!!! ???' }));
    expect(r.ok && r.value.id).toBe('task');
  });
});

describe('task lifecycle', () => {
  beforeEach(async () => {
    await project();
    const r = await svc.createTask(taskInput());
    expect(r.ok).toBe(true);
    d.sessions.push(makeSession('w1', { parent: 'fix-the-header' }));
  });

  it('stop kills the tree, resume restores the orchestrator', async () => {
    expect(await svc.stopTask('fix-the-header')).toEqual({ ok: true, value: null });
    expect(d.sessions.map((s) => [s.id, s.state])).toEqual([['fix-the-header', 'killed'], ['w1', 'killed']]);
    expect(await svc.resumeTask('fix-the-header')).toEqual({ ok: true, value: null });
    expect(d.sessions.find((s) => s.id === 'fix-the-header')!.state).toBe('running');
    // resuming a running task changes nothing
    expect((await svc.resumeTask('fix-the-header')).ok).toBe(true);
    expect(d.requests.filter((r) => r.url.endsWith('/restore'))).toHaveLength(1);
  });

  it('finish stops everything as done and moves the task to Recent, keeping its folder', async () => {
    expect((await svc.finishTask('fix-the-header')).ok).toBe(true);
    expect(d.sessions.every((s) => s.state === 'done')).toBe(true);
    const t = (await svc.state()).tasks[0]!;
    expect(t).toMatchObject({ status: 'finished', finishedAt: 1000 });
    expect(existsSync(t.dir)).toBe(true);
    const r = await svc.resumeTask('fix-the-header');
    expect(!r.ok && r.error.code).toBe('task_finished');
  });

  it('hide is refused while the task runs', async () => {
    const r = await svc.hideTask('fix-the-header');
    expect(!r.ok && r.error.code).toBe('task_running');
    await svc.stopTask('fix-the-header');
    expect((await svc.hideTask('fix-the-header')).ok).toBe(true);
    expect((await svc.state()).tasks[0]!.hidden).toBe(true);
  });

  it('unknown task and missing session are errors, not throws', async () => {
    expect((await svc.stopTask('nope')).ok).toBe(false);
    d.sessions = [];
    const r = await svc.stopTask('fix-the-header');
    expect(!r.ok && r.error.code).toBe('session_missing');
  });
});

describe('long-lived agents', () => {
  let folder: string;
  beforeEach(() => {
    folder = join(root, 'cto-home');
    mkdirSync(folder);
  });

  it('create registers a mailbox; start launches with id = name and the agent text', async () => {
    const r = await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    expect(r.ok && r.value).toEqual({ name: 'cto', profile: 'sonnet', dir: folder, createdAt: 1000 });
    expect(d.mailboxes.map((b) => b.name)).toEqual(['cto']);
    expect((await svc.startAgent('cto')).ok).toBe(true);
    const body = d.created.at(-1)!;
    expect(body).toMatchObject({ id: 'cto', dir: folder, profile: 'sonnet', labels: { 'hopp.agent': 'cto' } });
    expect(String(body['system_prompt'])).toContain('# You run inside hopp');
    expect(String(body['system_prompt'])).not.toContain('# Your role');
    expect(body['spawn_dirs']).toBeUndefined();
    expect(body['message']).toBeUndefined();
  });

  it('a mailbox that exists already is fine', async () => {
    d.mailboxes.push({ name: 'cto', unread: 3, total: 3 });
    expect((await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder })).ok).toBe(true);
  });

  it('start of a running agent does nothing; after stop it restores', async () => {
    await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    await svc.startAgent('cto');
    expect((await svc.startAgent('cto')).ok).toBe(true);
    expect(d.created).toHaveLength(1);
    expect((await svc.stopAgent('cto')).ok).toBe(true);
    expect(d.sessions[0]!.state).toBe('killed');
    expect((await svc.startAgent('cto')).ok).toBe(true);
    expect(d.sessions[0]!.state).toBe('running');
    expect(d.created).toHaveLength(1);
  });

  it('an agent whose session ended done says how to start fresh', async () => {
    await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    d.sessions.push(makeSession('cto', { state: 'done' }));
    const r = await svc.startAgent('cto');
    expect(!r.ok && r.error.code).toBe('agent_done');
  });

  it('remove is refused while it runs', async () => {
    await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    await svc.startAgent('cto');
    expect((await svc.removeAgent('cto')).ok).toBe(false);
    await svc.stopAgent('cto');
    expect((await svc.removeAgent('cto')).ok).toBe(true);
    expect((await svc.state()).agents).toEqual([]);
  });

  it('validates name, profile and folder by field', async () => {
    await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    const cases: [Parameters<typeof svc.createAgent>[0], string, string][] = [
      [{ name: 'Bad', profile: 'sonnet', dir: folder }, 'name', 'name_invalid'],
      [{ name: 'cto', profile: 'sonnet', dir: folder }, 'name', 'name_taken'],
      [{ name: 'ops', profile: 'off', dir: folder }, 'profile', 'profile_unknown'],
      [{ name: 'ops', profile: 'sonnet', dir: join(root, 'missing') }, 'dir', 'folder_missing'],
      [{ name: 'ops', profile: 'sonnet', dir: 'rel' }, 'dir', 'folder_missing'],
    ];
    for (const [input, field, code] of cases) {
      const r = await svc.createAgent(input);
      expect(!r.ok && [r.error.field, r.error.code], JSON.stringify(input)).toEqual([field, code]);
    }
  });

  it('agentMail counts unread mail of agents that are switched off', async () => {
    await svc.createAgent({ name: 'cto', profile: 'sonnet', dir: folder });
    await svc.createAgent({ name: 'ops', profile: 'sonnet', dir: folder });
    d.mailboxes = [{ name: 'cto', unread: 2, total: 5 }, { name: 'ops', unread: 4, total: 4 }];
    await svc.startAgent('ops');
    expect(await svc.agentMail()).toEqual({ cto: 2 });
  });
});

describe('tools, lessons, waiting', () => {
  it('lists the catalog with broken tools and reads usage', async () => {
    const c = await svc.listTools();
    expect(c.tools.map((t) => t.name)).toEqual(['fetcher']);
    expect(c.broken).toEqual([{ name: 'bad', error: 'tool.yaml: line 1: x' }]);
    expect(await svc.toolUsage('fetcher')).toBe('Run curl.\n');
  });

  it('switches tools and reports a failure as a result', async () => {
    expect(await svc.setToolEnabled('fetcher', false)).toEqual({ ok: true, value: null });
    expect(hoppCalls.at(-1)).toEqual(['tools', 'disable', 'fetcher']);
    const r = await svc.setToolEnabled('ghost', true);
    expect(!r.ok && r.error.message).toContain('ghost');
  });

  it('writes the rules file and returns it with its time', async () => {
    expect(await svc.toolRules()).toEqual({ text: '', modifiedAt: 0 });
    const r = await svc.setToolRules('Video: use X.');
    expect(r).toEqual({ ok: true, value: { text: 'Video: use X.\n', modifiedAt: 123 } });
    expect(readFileSync(join(home, 'tools', 'rules.md'), 'utf8')).toBe('Video: use X.\n');
  });

  it('lists and closes lessons', async () => {
    d.lessons = [makeLesson(1), makeLesson(2, { status: 'closed' })];
    expect((await svc.listLessons('new')).map((l) => l.id)).toEqual([1]);
    expect((await svc.listLessons('all')).map((l) => l.id)).toEqual([1, 2]);
    expect((await svc.closeLesson(1)).ok).toBe(true);
    expect((await svc.listLessons('new'))).toEqual([]);
    expect((await svc.closeLesson(9)).ok).toBe(false);
  });

  it('waiting comes from the daemon', async () => {
    d.sessions = [makeSession('a', { question: { questions: [], asked_at: 1 } })];
    expect((await svc.waiting()).questions.map((q) => q.session)).toEqual(['a']);
  });
});
