// The built command (out/cli's bundle) run as real processes: two at once,
// while the app holds the store, and through the open app's socket.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeProfile } from '../../test/fakeDaemon';
import { DaemonClient } from '../main/daemon/client';
import { makeRunner, type Runner } from '../main/shell/exec';
import { withFileLock } from '../main/shell/lock';
import { serveShell, shellSocketPath, type ShellServer } from '../main/shell/server';
import { ShellService } from '../main/shell/service';
import { ShellStore } from '../main/shell/store';

let bundleDir: string;
let bundle: string;
let root: string;
let home: string;
let d: FakeDaemon;
let fakeHoppBin: string;
let server: ShellServer | null = null;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'hopp-cli-bundle-'));
  await build({ configFile: resolve(__dirname, '../../cli.vite.config.ts'), logLevel: 'silent', build: { outDir: bundleDir, emptyOutDir: true } });
  bundle = join(bundleDir, 'hopp-shell.cjs');
}, 60_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-clip-')));
  home = join(root, 'h');
  d = new FakeDaemon(join(root, 'd'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('sonnet')];
  d.defaultProfile = 'sonnet';
  // The hopp binary a command run without the app calls for the tools section.
  fakeHoppBin = join(root, 'hopp');
  writeFileSync(fakeHoppBin, '#!/bin/sh\nprintf "## Tools\\n"\n');
  chmodSync(fakeHoppBin, 0o755);
  const svc = appService();
  const r = await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
  if (!r.ok) throw new Error(r.error.message);
});
afterEach(async () => {
  await server?.close();
  server = null;
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

const fakeHopp: Runner = async () => ({ stdout: '## Tools\n', stderr: '' });
function appService(): ShellService {
  const git = makeRunner('git', () => process.env);
  return new ShellService({ home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git, hopp: fakeHopp, pickFolder: async () => null });
}

function cli(args: string[], opts: { stdin?: string; hoppBin?: string } = {}): Promise<{ code: number; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [bundle, ...args], {
      env: { PATH: process.env['PATH'], HOME: root, HOPP_HOME: home, HOPP_SOCKET: d.socketPath, HOPP_BIN: opts.hoppBin ?? fakeHoppBin },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', fail);
    p.on('close', (code) => done({ code: code ?? -1, out, err, ms: Date.now() - t0 }));
    p.stdin.end(opts.stdin ?? '');
  });
}

const tasks = async () => (await new ShellStore(home).read()).tasks;

describe('the command as a process', () => {
  it('two at once with the app closed make two tasks', async () => {
    const [a, b] = await Promise.all([
      cli(['task', 'new', '--project', 'site', '--brief', 'Same', '--json']),
      cli(['task', 'new', '--project', 'site', '--brief', 'Same', '--json']),
    ]);
    expect([a.code, b.code], a.err + b.err).toEqual([0, 0]);
    expect(new Set([JSON.parse(a.out).task, JSON.parse(b.out).task])).toEqual(new Set(['same', 'same-2']));
    expect((await tasks()).map((t) => t.id).sort()).toEqual(['same', 'same-2']);
  }, 30_000);

  it('waits while the app holds the store, then records its task', async () => {
    const lock = join(home, 'shell', 'state.lock');
    let started = 0;
    const held = withFileLock(lock, async () => {
      started = Date.now();
      await new Promise((r) => setTimeout(r, 800));
    });
    const r = await cli(['task', 'new', '--project', 'site', '--brief', 'Под замком', '--json']);
    await held;
    expect(r.code, r.err).toBe(0);
    expect(started).toBeGreaterThan(0);
    expect(r.ms).toBeGreaterThanOrEqual(600); // it waited for the lock
    expect((await tasks()).map((t) => t.brief)).toEqual(['Под замком']);
  }, 30_000);

  it('goes through the open app when it runs', async () => {
    server = await serveShell(appService(), shellSocketPath(home));
    // Without the app this would fail: there is no hopp binary to read the tools from.
    const r = await cli(['task', 'new', '--project', 'site', '--brief', 'Via the app', '--json'], { hoppBin: '/nonexistent/hopp' });
    expect(r.code, r.err).toBe(0);
    expect((await tasks()).map((t) => t.id)).toEqual(['via-the-app']);
    // And with the app closed the same command tells why it failed.
    await server.close();
    server = null;
    const r2 = await cli(['task', 'new', '--project', 'site', '--brief', 'Without', '--json'], { hoppBin: '/nonexistent/hopp' });
    expect(r2.code).toBe(1);
    expect(r2.err).toMatch(/tool catalog/);
  }, 30_000);

  it('reads the brief from a pipe: Cyrillic and newlines intact', async () => {
    const brief = 'Первая строка\nвторая — «с кавычками»\n\tи табуляцией';
    const r = await cli(['task', 'new', '--project', 'site', '--json'], { stdin: brief + '\n' });
    expect(r.code, r.err).toBe(0);
    expect((await tasks())[0]!.brief).toBe(brief);
    expect(d.created[0]!['message']).toBe(brief);
  }, 30_000);

  it('exits 3 on a usage error and 1 on an unknown project', async () => {
    expect((await cli(['task'])).code).toBe(3);
    const r = await cli(['task', 'new', '--project', 'nope', '--brief', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no project "nope"/);
  }, 30_000);
});
