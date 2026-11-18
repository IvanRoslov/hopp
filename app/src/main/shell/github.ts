// GitHub through the user's own `gh` CLI: who is logged in, which
// repositories they can access, and managed clones of them in
// <HOPP_HOME>/repos/<owner>__<repo>. hopp stores no token, and the daemon
// learns nothing about git.
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GithubRepo, GithubStatus, Result } from '../../shared/shell';
import { managedRepoFolder, managedRepoName, REPOS_DIR } from '../../shared/repos';
import { RunError, type Runner } from './exec';
import type { KeyedQueue } from './lock';
import { fail } from './projects';

const LIST_TTL_MS = 5 * 60_000;
const LIST_CAP = 1000;

interface ApiRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
}

export class Github {
  private cache: { at: number; repos: Omit<GithubRepo, 'cloned'>[] } | null = null;
  private clones = new Map<string, Promise<Result<{ path: string }>>>();
  private preparing = new Map<string, Promise<{ base: string; warning: string; fetched: boolean }>>();

  constructor(
    private readonly home: string,
    private readonly gh: Runner,
    private readonly git: Runner,
    private readonly now: () => number = () => Date.now(),
    // A fetch that runs out counts as a failed one: the task still starts.
    private readonly fetchTimeoutMs = 60_000,
  ) {}

  get reposDir(): string {
    return join(this.home, REPOS_DIR);
  }

  async status(): Promise<GithubStatus> {
    const base = { login: '', home: this.home };
    try {
      await this.gh(['--version']);
    } catch (err) {
      if (notInstalled(err)) {
        return { ...base, available: false, reason: 'The GitHub CLI (gh) is not installed.', command: 'brew install gh' };
      }
      return { ...base, available: false, reason: 'The GitHub CLI (gh) does not run: ' + (err as Error).message, command: 'gh --version' };
    }
    try {
      const login = (await this.gh(['api', 'user', '--jq', '.login'])).stdout.trim();
      if (!login) throw new RunError('no login');
      return { ...base, available: true, login, reason: '', command: '' };
    } catch {
      return { ...base, available: false, reason: 'The GitHub CLI (gh) is not logged in.', command: 'gh auth login' };
    }
  }

  // list: repositories the user can access, most recently pushed first.
  async list(query: string): Promise<Result<GithubRepo[]>> {
    if (!this.cache || this.now() - this.cache.at > LIST_TTL_MS) {
      const st = await this.status();
      if (!st.available) return fail('github_unavailable', `${st.reason} Run \`${st.command}\`.`);
      let out: string;
      try {
        out = (
          await this.gh([
            'api', '--paginate',
            'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
            '--jq', '.[] | {full_name, description, private, default_branch, pushed_at}',
          ])
        ).stdout;
      } catch (err) {
        return fail('github_failed', 'Could not list repositories with gh: ' + (err as Error).message);
      }
      const repos: Omit<GithubRepo, 'cloned'>[] = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as ApiRepo;
          repos.push({
            fullName: r.full_name, description: r.description ?? '', private: !!r.private,
            defaultBranch: r.default_branch || '', updatedAt: r.pushed_at ?? '',
          });
        } catch {
          // a line gh did not print as JSON: skip it
        }
        if (repos.length >= LIST_CAP) break;
      }
      repos.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
      this.cache = { at: this.now(), repos };
    }
    const q = query.trim().toLowerCase();
    const hits = this.cache.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
    return { ok: true, value: hits.map((r) => ({ ...r, cloned: this.isCloned(r.fullName) })) };
  }

  private pathOf(fullName: string): string | null {
    const folder = managedRepoFolder(fullName);
    return folder ? join(this.reposDir, folder) : null;
  }

  private isCloned(fullName: string): boolean {
    const p = this.pathOf(fullName);
    return !!p && existsSync(join(p, '.git'));
  }

  // add clones owner/repo unless a clone is there; two calls at once share one
  // clone. A clone goes into a temp folder first and is renamed into place
  // only when complete, so a failed clone never leaves a folder behind.
  add(fullName: string): Promise<Result<{ path: string }>> {
    const path = this.pathOf(fullName);
    if (!path) return Promise.resolve(fail('repo_invalid', `"${fullName}" is not a GitHub owner/repo name`));
    const running = this.clones.get(path);
    if (running) return running;
    const p = this.clone(fullName.trim(), path).finally(() => this.clones.delete(path));
    this.clones.set(path, p);
    return p;
  }

  private async clone(fullName: string, path: string): Promise<Result<{ path: string }>> {
    if (existsSync(join(path, '.git'))) return { ok: true, value: { path } };
    if (existsSync(path)) {
      return fail('repo_folder_taken', `${path} exists but is not a git clone; move it away and try again`);
    }
    await mkdir(this.reposDir, { recursive: true });
    const tmp = join(this.reposDir, `.${managedRepoFolder(fullName)}.cloning-${process.pid}-${this.now()}`);
    try {
      await this.gh(['repo', 'clone', fullName, tmp, '--', '--quiet']);
      await rename(tmp, path);
      this.cache = null;
      return { ok: true, value: { path } };
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      if (notInstalled(err)) return fail('github_unavailable', 'The GitHub CLI (gh) is not installed. Run `brew install gh`.');
      return fail('clone_failed', `Could not clone ${fullName}: ${(err as Error).message}`);
    }
  }

  isManaged(path: string): boolean {
    return managedRepoName(path, this.home) !== null;
  }

  // prepare fetches a managed clone (best effort) and returns the ref a new
  // worktree should start from: origin/<default branch>. warning says why
  // the fetch failed, when it did. A clone without any commit is an error.
  // Launches that want the same clone at once share one fetch; it runs in
  // the clone's turn of repoQueue, so it never overlaps another launch's git
  // write there.
  prepare(repo: string, repoQueue?: KeyedQueue): Promise<{ base: string; warning: string; fetched: boolean }> {
    const running = this.preparing.get(repo);
    if (running) return running;
    const work = () => this.prepareNow(repo);
    const p = (repoQueue ? repoQueue.run(repo, work) : work()).finally(() => this.preparing.delete(repo));
    this.preparing.set(repo, p);
    return p;
  }

  private async prepareNow(repo: string): Promise<{ base: string; warning: string; fetched: boolean }> {
    let warning = '';
    let fetched = false;
    try {
      await this.git(['-C', repo, 'fetch', 'origin', '--prune'], { timeoutMs: this.fetchTimeoutMs });
      fetched = true;
    } catch (err) {
      warning = `could not fetch ${managedRepoName(repo, this.home) ?? repo} (${(err as Error).message}); its worktree starts from the last fetched state`;
    }
    const verify = async (ref: string) => {
      try {
        await this.git(['-C', repo, 'rev-parse', '--verify', '--quiet', ref + '^{commit}']);
        return true;
      } catch {
        return false;
      }
    };
    let head = '';
    try {
      head = (await this.git(['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
    } catch {
      // origin/HEAD unknown (an empty repo, or a clone made without it)
    }
    for (const ref of [head, 'origin/main', 'origin/master', 'HEAD'].filter(Boolean)) {
      if (await verify(ref)) return { base: ref, warning, fetched };
    }
    throw new RunError(`${managedRepoName(repo, this.home) ?? repo} has no commits yet; push a first commit to it and try again`);
  }
}

function notInstalled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return e?.code === 'ENOENT' || /not found on PATH/.test(e?.message ?? '');
}
