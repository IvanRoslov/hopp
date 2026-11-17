// World: everything an end-to-end test needs, isolated in one temp folder:
// a fake daemon whose home is the app's HOPP_HOME, the real hopp CLI built
// from daemon/ (for `hopp tools`), throwaway git repositories, and the app
// launched with a PATH that finds that hopp first. Nothing reaches ~/.hopp,
// a real repository or the human's login shell.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Task } from '../src/shared/shell';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeDaemon, makeProfile } from '../test/fakeDaemon';
import { appDir } from './launch';

let builtHopp: string | null = null;

// hoppBinary builds hopp from daemon/ once per test process.
export function hoppBinary(): string {
  if (builtHopp) return builtHopp;
  const dir = mkdtempSync(join(tmpdir(), 'hopp-e2e-bin-'));
  const bin = join(dir, 'hopp');
  execFileSync('go', ['build', '-o', bin, './cmd/hopp'], { cwd: join(appDir, '..', 'daemon'), stdio: 'ignore' });
  // The first run of a freshly built program waits for macOS to check it:
  // 0.4 s when idle, 3 to 11 s under load (measured), against 0.04 s later.
  // Run it once here, so that wait never lands inside a test's 5 s step
  // (Start runs `hopp tools prompt`).
  execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 120_000 });
  builtHopp = bin;
  return bin;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

export class World {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly d: FakeDaemon;
  app: ElectronApplication | null = null;

  constructor() {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-e2e-')));
    this.home = join(this.root, 'home');
    mkdirSync(this.home);
    this.bin = join(this.root, 'bin');
    mkdirSync(this.bin);
    symlinkSync(hoppBinary(), join(this.bin, 'hopp'));
    this.d = new FakeDaemon(this.home);
    this.d.profiles = [
      makeProfile('deepseek-flash-1m', { agent: 'deepseek', model: 'deepseek-chat' }),
      makeProfile('sonnet', { agent: 'claude-code', model: 'claude-sonnet-5-5' }),
    ];
    this.d.defaultAttach = ['/bin/sh', '-c', 'echo agent screen; exec cat'];
  }

  // repo makes a throwaway git repository with one commit.
  repo(name: string): string {
    const dir = join(this.root, name);
    mkdirSync(dir);
    const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'e2e@example.invalid');
    g('config', 'user.name', 'e2e');
    writeFileSync(join(dir, 'README.md'), '# ' + name + '\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    return dir;
  }

  // seedTask writes a store with one project and one running task whose
  // orchestrator session is `sessionId`, as if the app had launched it.
  seedTask(sessionId: string, title: string): Task {
    const task: Task = {
      id: sessionId, projectSlug: 'site', title, brief: title, sessionId, dir: join(this.root, sessionId), branch: null,
      orchestratorProfile: 'sonnet', workerProfiles: ['sonnet'], pipeline: null, base: null, startedBy: null, status: 'active', hidden: false,
      createdAt: Math.floor(Date.now() / 1000) - 3600, finishedAt: 0,
    };
    mkdirSync(task.dir, { recursive: true });
    mkdirSync(join(this.home, 'shell'), { recursive: true });
    writeFileSync(join(this.home, 'shell', 'state.json'), JSON.stringify({
      version: 1, seeded: ['starter-pipelines'],
      projects: [{ slug: 'site', name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 1 }],
      pipelines: [], tasks: [task], agents: [],
    }));
    return task;
  }

  git(repo: string, ...args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], { env: GIT_ENV }).toString();
  }

  async start(): Promise<Page> {
    await this.d.start();
    this.app = await electron.launch({
      args: [appDir],
      cwd: appDir,
      env: {
        ...(process.env as Record<string, string>),
        HOPP_HOME: this.home,
        PATH: `${this.bin}:${process.env['PATH'] ?? ''}`,
        // No login shell: its PATH would put the human's own hopp first.
        SHELL: '/usr/bin/false',
        HOPP_SESSION_ID: '',
      },
    });
    const page = await this.app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    return page;
  }

  async dispose(): Promise<void> {
    await this.app?.close().catch(() => {});
    await this.d.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}
