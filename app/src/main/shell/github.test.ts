// GitHub repositories with gh faked: "GitHub" is a set of local bare
// repositories, and `gh repo clone` clones from them with real git.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDaemon, makeProfile } from '../../../test/fakeDaemon';
import { DaemonClient } from '../daemon/client';
import { makeRunner, RunError, type Runner } from './exec';
import { ShellService } from './service';
import { ShellStore } from './store';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = makeRunner('git', () => GIT_ENV);
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env: GIT_ENV }).toString();

let root: string;
let home: string;
let gh: GhFake;
let d: FakeDaemon;
let svc: ShellService;

interface ApiRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  pushed_at: string;
}

class GhFake {
  installed = true;
  login = 'ivan';
  repos: ApiRepo[] = [];
  origins = new Map<string, string>();
  calls: string[][] = [];
  failCloneHalfway = false;
  cloneDelayMs = 0;

  runner: Runner = async (args) => {
    this.calls.push(args);
    if (!this.installed) throw Object.assign(new RunError('spawn gh ENOENT'), { code: 'ENOENT' });
    if (args[0] === '--version') return { stdout: 'gh version 2.99.0\n', stderr: '' };
    if (args[0] === 'api' && args[1] === 'user') {
      if (!this.login) throw new RunError('To get started with GitHub CLI, please run:  gh auth login');
      return { stdout: this.login + '\n', stderr: '' };
    }
    if (args[0] === 'api' && args.includes('--paginate')) {
      return { stdout: this.repos.map((r) => JSON.stringify(r)).join('\n') + '\n', stderr: '' };
    }
    if (args[0] === 'repo' && args[1] === 'clone') {
      const [, , name, dir] = args;
      const origin = this.origins.get(name!);
      if (!origin) throw new RunError(`GraphQL: Could not resolve to a Repository with the name '${name}'.`);
      if (this.cloneDelayMs) await new Promise((r) => setTimeout(r, this.cloneDelayMs));
      if (this.failCloneHalfway) {
        mkdirSync(join(dir!, '.git'), { recursive: true });
        writeFileSync(join(dir!, 'half'), 'x');
        throw new RunError('fatal: early EOF\nfatal: fetch-pack: invalid index-pack output');
      }
      execFileSync('git', ['clone', '--quiet', origin, dir!], { env: GIT_ENV });
      return { stdout: '', stderr: '' };
    }
    throw new RunError('unexpected gh call: ' + args.join(' '));
  };
}

// origin makes a bare "GitHub" repository with one commit on main (or none).
function origin(name: string, commit = true): string {
  const bare = join(root, 'github', name.replace('/', '__') + '.git');
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  if (commit) push(bare, 'README.md', '# ' + name + '\n', 'init');
  gh.origins.set(name, bare);
  return bare;
}

// push adds a commit to the bare repository through a scratch clone.
function push(bare: string, file: string, text: string, msg: string): void {
  const work = mkdtempSync(join(root, 'push-'));
  execFileSync('git', ['clone', '--quiet', bare, work], { env: GIT_ENV });
  writeFileSync(join(work, file), text);
  sh(work, 'add', '.');
  sh(work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', msg);
  sh(work, 'push', '-q', 'origin', 'HEAD:main');
  rmSync(work, { recursive: true, force: true });
}

const api = (full: string, pushed: string, over: Partial<ApiRepo> = {}): ApiRepo => ({
  full_name: full, description: 'about ' + full, private: false, default_branch: 'main', pushed_at: pushed, ...over,
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-gh-')));
  home = join(root, 'home');
  mkdirSync(home);
  gh = new GhFake();
  d = new FakeDaemon(join(root, 'daemon'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('p')];
  svc = new ShellService({
    home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git,
    hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null, gh: gh.runner,
  });
});
afterEach(async () => {
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('githubStatus', () => {
  it('gh not installed: unavailable, says how to install it', async () => {
    gh.installed = false;
    expect(await svc.githubStatus()).toEqual({ available: false, login: '', reason: 'The GitHub CLI (gh) is not installed.', command: 'brew install gh', home });
    const r = await svc.listGithubRepos('');
    expect(!r.ok && r.error).toMatchObject({ code: 'github_unavailable' });
    expect(!r.ok && r.error.message).toContain('brew install gh');
  });

  it('gh not logged in: unavailable, says how to log in', async () => {
    gh.login = '';
    expect(await svc.githubStatus()).toMatchObject({ available: false, command: 'gh auth login' });
  });

  it('logged in: the login', async () => {
    expect(await svc.githubStatus()).toEqual({ available: true, login: 'ivan', reason: '', command: '', home });
  });

  it('without a gh runner at all it is unavailable, not a crash', async () => {
    const bare = new ShellService({
      home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git,
      hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null,
    });
    expect((await bare.githubStatus()).command).toBe('brew install gh');
  });
});

describe('listGithubRepos', () => {
  it('most recently pushed first, filtered, with the cloned mark, and cached', async () => {
    gh.repos = [api('ivan/old', '2026-01-01T00:00:00Z'), api('ivan/new', '2026-11-01T00:00:00Z'), api('org/Site.Web', '2026-06-01T00:00:00Z', { private: true, description: null })];
    origin('ivan/new');
    expect((await svc.addGithubRepo('ivan/new')).ok).toBe(true);
    const r = await svc.listGithubRepos('');
    expect(r.ok && r.value.map((x) => [x.fullName, x.cloned])).toEqual([['ivan/new', true], ['org/Site.Web', false], ['ivan/old', false]]);
    expect(r.ok && r.value[1]).toMatchObject({ private: true, description: '', defaultBranch: 'main', updatedAt: '2026-06-01T00:00:00Z' });
    const q = await svc.listGithubRepos('SITE');
    expect(q.ok && q.value.map((x) => x.fullName)).toEqual(['org/Site.Web']);
    const apiCalls = () => gh.calls.filter((c) => c[0] === 'api' && c.includes('--paginate')).length;
    expect(apiCalls()).toBe(1);
    const call = gh.calls.find((c) => c.includes('--paginate'))!;
    expect(call.join(' ')).toContain('affiliation=owner,collaborator,organization_member');
  });

  it('lists again after a few minutes', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      gh.repos = [api('ivan/a', '2026-01-01T00:00:00Z')];
      await svc.listGithubRepos('');
      gh.repos.push(api('ivan/b', '2026-02-01T00:00:00Z'));
      now += 60_000;
      expect(((await svc.listGithubRepos('')) as { value: unknown[] }).value).toHaveLength(1);
      now += 5 * 60_000;
      expect(((await svc.listGithubRepos('')) as { value: unknown[] }).value).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('addGithubRepo', () => {
  it('clones into <home>/repos/<owner>__<repo>, keeping dots and capitals, and is idempotent', async () => {
    origin('Ivan.R/My.Repo');
    const r = await svc.addGithubRepo('Ivan.R/My.Repo');
    const path = join(home, 'repos', 'Ivan.R__My.Repo');
    expect(r).toEqual({ ok: true, value: { path } });
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# Ivan.R/My.Repo\n');
    expect(await svc.addGithubRepo('Ivan.R/My.Repo')).toEqual({ ok: true, value: { path } });
    expect(gh.calls.filter((c) => c[1] === 'clone')).toHaveLength(1);
  });

  it('refuses a name that is not owner/repo', async () => {
    for (const bad of ['../etc', 'a/b/c', 'x', 'a/..']) {
      const r = await svc.addGithubRepo(bad);
      expect(!r.ok && r.error.code, bad).toBe('repo_invalid');
    }
    expect(existsSync(join(home, 'repos'))).toBe(false);
  });

  it('a clone that fails half-way leaves no folder that would count as cloned', async () => {
    origin('ivan/site');
    gh.failCloneHalfway = true;
    const r = await svc.addGithubRepo('ivan/site');
    expect(!r.ok && r.error.code).toBe('clone_failed');
    expect(readdirSync(join(home, 'repos'))).toEqual([]);
    gh.repos = [api('ivan/site', '2026-01-01T00:00:00Z')];
    expect(((await svc.listGithubRepos('')) as { value: { cloned: boolean }[] }).value[0]!.cloned).toBe(false);
    gh.failCloneHalfway = false;
    expect((await svc.addGithubRepo('ivan/site')).ok).toBe(true);
  });

  it('two calls at once for one repository share one clone', async () => {
    origin('ivan/site');
    gh.cloneDelayMs = 200;
    const [a, b] = await Promise.all([svc.addGithubRepo('ivan/site'), svc.addGithubRepo('ivan/site')]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(gh.calls.filter((c) => c[1] === 'clone')).toHaveLength(1);
  });

  it('a folder in the way that is not a clone is reported, not overwritten', async () => {
    origin('ivan/site');
    mkdirSync(join(home, 'repos', 'ivan__site'), { recursive: true });
    writeFileSync(join(home, 'repos', 'ivan__site', 'mine.txt'), 'keep');
    const r = await svc.addGithubRepo('ivan/site');
    expect(!r.ok && r.error.code).toBe('repo_folder_taken');
    expect(readFileSync(join(home, 'repos', 'ivan__site', 'mine.txt'), 'utf8')).toBe('keep');
  });
});

describe('a task on a managed clone', () => {
  async function projectOn(full: string, workers: string[] = []) {
    const r = await svc.addGithubRepo(full);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const ws: string[] = [];
    for (const w of workers) {
      const x = await svc.addGithubRepo(w);
      if (!x.ok) throw new Error(JSON.stringify(x.error));
      ws.push(x.value.path);
    }
    const p = await svc.createProject({ name: 'Site', description: '', orchestratorRepo: r.value.path, workerRepos: ws, guardrails: '' });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    return r.value.path;
  }
  const task = () => svc.createTask({ projectSlug: 'site', brief: 'Fix it', orchestratorProfile: 'p', workerProfiles: [] });

  it('fetches first and bases the worktree on origin/<default branch>, not the clone\'s HEAD', async () => {
    const bare = origin('ivan/site');
    const clone = await projectOn('ivan/site');
    // The clone sits on an old local branch; GitHub moves on.
    sh(clone, 'checkout', '-q', '-b', 'old-local');
    push(bare, 'NEW.md', 'new\n', 'newer on github');
    const r = await task();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(join(r.value.dir, 'NEW.md'), 'utf8')).toBe('new\n');
    expect(sh(r.value.dir, 'log', '-1', '--format=%s').trim()).toBe('newer on github');
    expect(String(d.created.at(-1)!['system_prompt'])).toContain(`${clone} — a clone of a GitHub repository; base worker worktrees on \`origin/main\``);
  });

  it('fetch fails offline: the task still starts, from what was fetched last, with a warning', async () => {
    const bare = origin('ivan/site');
    await projectOn('ivan/site');
    renameSync(bare, bare + '.gone');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await task();
      expect(r.ok).toBe(true);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/could not fetch ivan\/site/);
    } finally {
      warn.mockRestore();
    }
  });

  it('a repository with no commits refuses the task clearly and makes nothing', async () => {
    origin('ivan/empty', false);
    await projectOn('ivan/empty');
    const r = await task();
    expect(!r.ok && r.error).toMatchObject({ code: 'repo_empty' });
    expect(!r.ok && r.error.message).toContain('ivan/empty has no commits yet');
    expect(existsSync(join(home, 'worktrees', 'site'))).toBe(false);
    expect(d.created).toEqual([]);
  });

  it('managed worker repositories are fetched too and named with their base', async () => {
    origin('ivan/site');
    const api2 = origin('ivan/api');
    await projectOn('ivan/site', ['ivan/api']);
    push(api2, 'API.md', 'v2\n', 'api moves on');
    const r = await task();
    expect(r.ok).toBe(true);
    const apiClone = join(home, 'repos', 'ivan__api');
    expect(sh(apiClone, 'log', '-1', '--format=%s', 'origin/main').trim()).toBe('api moves on');
    const sp = String(d.created.at(-1)!['system_prompt']);
    expect(sp).toContain(`${apiClone} — a clone of a GitHub repository; base worker worktrees on \`origin/main\``);
    expect(sp).toContain('[<base>]');
  });

  it('a plain folder repository keeps starting from HEAD, and its text has no base', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    sh(plain, 'init', '-q', '-b', 'main');
    writeFileSync(join(plain, 'a'), 'a');
    sh(plain, 'add', '.');
    sh(plain, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
    sh(plain, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(plain, 'b'), 'b');
    sh(plain, 'add', '.');
    sh(plain, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'on feature');
    await svc.createProject({ name: 'Site', description: '', orchestratorRepo: plain, workerRepos: [], guardrails: '' });
    const r = await task();
    expect(r.ok && sh(r.value.dir, 'log', '-1', '--format=%s').trim()).toBe('on feature');
    expect(String(d.created.at(-1)!['system_prompt'])).not.toContain('[<base>]');
  });

  it('removing the project keeps the clones', async () => {
    origin('ivan/site');
    const clone = await projectOn('ivan/site');
    expect((await svc.removeProject('site')).ok).toBe(true);
    expect(existsSync(join(clone, '.git'))).toBe(true);
  });
});
