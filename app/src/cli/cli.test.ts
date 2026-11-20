import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { FakeDaemon, makeProfile, makeSession } from '../../test/fakeDaemon';
import type { ShellState } from '../shared/shell';
import { DaemonClient, DaemonError } from '../main/daemon/client';
import { makeRunner, RunError, type Runner } from '../main/shell/exec';
import { privateDirOk, serveShell, shellSocketPath, type ShellServer } from '../main/shell/server';
import { ShellService } from '../main/shell/service';
import { ShellStore } from '../main/shell/store';
import { runCli, type CliContext } from './commands';
import { appAnswers, connectShell, RemoteShell, type ShellApi } from './connect';

// A temp hopp home (the app home too), a fake daemon, and the app's service
// twice over the same store: once as the open app (served on its socket),
// once as a command run while the app is closed.
let root: string;
let home: string;
let d: FakeDaemon;
let appStore: ShellStore;
let app: ShellService;
let server: ShellServer | null;
let socket: string;

const git = makeRunner('git', () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }));
const fakeHopp: Runner = async (args) => {
  if (args[0] === 'tools' && args[1] === 'prompt') return { stdout: '## Tools\n', stderr: '' };
  throw new RunError('unexpected hopp call: ' + args.join(' '));
};
const service = (store: ShellStore) =>
  new ShellService({ home, store, client: new DaemonClient(d.socketPath), git, hopp: fakeHopp, pickFolder: async () => null });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-cli-')));
  home = join(root, 'h');
  d = new FakeDaemon(join(root, 'd'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('cheap', { agent: 'deepseek' }), makeProfile('sonnet'), makeProfile('off', { enabled: false })];
  d.defaultProfile = 'sonnet';
  appStore = new ShellStore(home);
  app = service(appStore);
  await app.seedPipelines();
  const r = await app.createProject({ name: 'Site', description: 'The web site', orchestratorRepo: null, workerRepos: [], guardrails: 'Be careful.' });
  if (!r.ok) throw new Error(r.error.message);
  socket = shellSocketPath(home);
  server = null;
});
afterEach(async () => {
  await server?.close();
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

async function serve(): Promise<RemoteShell> {
  server = await serveShell(app, socket);
  return new RemoteShell(socket);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(api: ShellApi, argv: string[], opts: { env?: Record<string, string>; stdin?: string | null } = {}): Promise<Run> {
  const client = new DaemonClient(d.socketPath);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    shell: async () => api,
    sessions: () => client.listSessions({ all: true }),
    getSession: async (id) => {
      try {
        return await client.getSession(id);
      } catch (e) {
        if (e instanceof DaemonError && e.status === 404) return null;
        throw e;
      }
    },
    env: opts.env ?? {},
    stdin: async () => opts.stdin ?? null,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  };
  const [noun, ...args] = argv;
  const code = await runCli(noun!, args, ctx);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const stateOf = async (): Promise<ShellState> => new ShellStore(home).read();

describe('the app running or not gives the same result', () => {
  it('for every read, a launch and the errors', async () => {
    const remote = await serve();
    const local = service(new ShellStore(home));
    const launched = await run(remote, ['task', 'new', '--project', 'site', '--brief', 'Fix the header']);
    expect(launched.code, launched.err).toBe(0);
    const reads = [
      ['project', 'ls'], ['project', 'show', 'site'], ['project', 'show', 'nope'],
      ['pipeline', 'ls'], ['pipeline', 'show', 'development'], ['pipeline', 'show', 'Landing', 'page'], ['pipeline', 'show', 'x'],
      ['task', 'ls'], ['task', 'ls', '--all', '--json'], ['task', 'show', 'fix-the-header'], ['task', 'show', 'fix-the-header', '--json'],
      ['task', 'feed', 'fix-the-header'], ['task', 'show', 'ghost'], ['task', 'bogus'], ['project', 'ls', '--nope'],
    ];
    for (const argv of reads) {
      const a = await run(remote, argv);
      const b = await run(local, argv);
      expect(b, argv.join(' ')).toEqual(a);
    }
    // And a launch made without the app shows in it, with the same output shape.
    const viaLocal = await run(local, ['task', 'new', '--project', 'site', '--brief', 'Fix the footer']);
    expect(viaLocal.code, viaLocal.err).toBe(0);
    expect(viaLocal.out.replaceAll('footer', 'header').replace("as the project's last task", "the orchestrator's profile")).toBe(launched.out);
    expect((await app.state()).tasks.map((t) => t.id).sort()).toEqual(['fix-the-footer', 'fix-the-header']);
  });

  it('connectShell uses the app when it answers and the store otherwise', async () => {
    const env = { HOPP_HOME: home, HOPP_SOCKET: d.socketPath, HOPP_BIN: '/nonexistent/hopp' };
    expect(await appAnswers(socket)).toBe(false);
    expect((await connectShell(env)).via).toBe('local');
    await serve();
    expect(await appAnswers(socket)).toBe(true);
    expect((await connectShell(env)).via).toBe('app');
  });
});

describe('task new', () => {
  it('picks the default profiles, says what it chose, and records the task', async () => {
    const r = await run(app, ['task', 'new', '--project', 'site', '--brief', 'Add a search box\nto the header']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('task:         add-a-search-box');
    expect(r.out).toContain("profile:      sonnet (the daemon's default)");
    expect(r.out).toContain("workers:      sonnet (the orchestrator's profile)");
    expect(r.out).toContain('hopp send add-a-search-box');
    expect(d.created[0]!['profile']).toBe('sonnet');
    // The next task in the project takes the workers of the last one.
    await run(app, ['task', 'new', '--project', 'site', '--brief', 'One', '--worker', 'cheap', '--worker', 'sonnet', '--json']);
    const r3 = await run(app, ['task', 'new', '--project', 'site', '--brief', 'Two', '--json']);
    expect(JSON.parse(r3.out)).toMatchObject({ task: 'two', orchestratorProfile: 'sonnet', workerProfiles: ['cheap', 'sonnet'], startedBy: null });
  });

  it('takes the brief from stdin, Cyrillic and newlines intact', async () => {
    const brief = 'Почини шапку сайта.\n\nЛоготип наезжает на меню — «срочно».\n';
    const r = await run(app, ['task', 'new', '--project', 'site', '--json'], { stdin: brief });
    expect(r.code, r.err).toBe(0);
    const id = JSON.parse(r.out).task as string;
    const t = (await stateOf()).tasks.find((x) => x.id === id)!;
    expect(t.brief).toBe(brief.trim());
    expect(t.title).toBe('Почини шапку сайта.');
    expect(d.created[0]!['message']).toBe(brief.trim());
    // --file - reads stdin too; a file works the same.
    const f = join(root, 'brief.md');
    writeFileSync(f, 'Ещё одна\nзадача');
    const r2 = await run(app, ['task', 'new', '--project', 'site', '--file', f, '--json']);
    expect(d.created[1]!['message']).toBe('Ещё одна\nзадача');
    expect(r2.code).toBe(0);
  });

  it('refuses an unknown project, pipeline or profile with a clear error', async () => {
    const cases: [string[], RegExp][] = [
      [['--project', 'nope'], /no project "nope"\. Projects: site/],
      [['--project', 'site', '--pipeline', 'nope'], /no pipeline "nope"\. Pipelines: development \("Development"\)/],
      [['--project', 'site', '--orchestrator', 'gpt'], /--orchestrator "gpt" is not an enabled profile\. Enabled: cheap, sonnet/],
      [['--project', 'site', '--worker', 'off'], /--worker "off" is not an enabled profile/],
    ];
    for (const [args, msg] of cases) {
      const r = await run(app, ['task', 'new', '--brief', 'x', ...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(msg);
    }
    expect(d.created).toHaveLength(0);
    // Usage errors: exit 3.
    expect((await run(app, ['task', 'new', '--brief', 'x'])).code).toBe(3);
    expect((await run(app, ['task', 'new', '--project', 'site'])).err).toMatch(/--brief/);
    expect((await run(app, ['task', 'new', '--project', 'site', 'loose', 'words'])).code).toBe(3);
  });

  it('names a pipeline by id or by name', async () => {
    const r = await run(app, ['task', 'new', '--project', 'site', '--brief', 'Promo', '--pipeline', 'promo video', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).pipeline).toBe('promo-video');
    expect((await stateOf()).tasks[0]!.pipeline?.name).toBe('Promo video');
  });

  it('started by an agent: records it, labels the orchestrator and tells both sides', async () => {
    d.sessions.push(makeSession('cto', { labels: { 'hopp.agent': 'cto' } }));
    const r = await run(app, ['task', 'new', '--project', 'site', '--brief', 'Ship it'], { env: { HOPP_SESSION_ID: 'cto' } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('The task reports to you (cto)');
    expect(r.out).toContain('hopp send ship-it "<text>"');
    expect((await stateOf()).tasks[0]!.startedBy).toBe('cto');
    const body = d.created[0]!;
    expect((body['labels'] as Record<string, string>)['hopp.started_by']).toBe('cto');
    expect(body['system_prompt']).toContain('This task was started by the agent cto, not typed by the human.');
    expect(body['system_prompt']).toContain('`hopp send cto`');
    const show = await run(app, ['task', 'show', 'ship-it']);
    expect(show.out).toContain('started by:   cto (an agent)');
  });

  it('is refused inside an orchestrator or a worker', async () => {
    d.sessions.push(makeSession('orch', { labels: { 'hopp.role': 'orchestrator', 'hopp.task': 'x' } }));
    d.sessions.push(makeSession('w1', { labels: { 'hopp.role': 'worker', 'hopp.task': 'x' } }));
    for (const who of ['orch', 'w1']) {
      const r = await run(app, ['task', 'new', '--project', 'site', '--brief', 'Nested'], { env: { HOPP_SESSION_ID: who } });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/tasks are not started from inside tasks/);
    }
    // The service refuses it too, whoever calls it.
    const svcRefusal = await app.createTask({ projectSlug: 'site', brief: 'x', orchestratorProfile: 'sonnet', workerProfiles: [], startedBy: 'w1' });
    expect(svcRefusal.ok).toBe(false);
    expect(d.created).toHaveLength(0);
  });

  it('two at once, with the same brief, through the app: two tasks', async () => {
    const remote = await serve();
    const [a, b] = await Promise.all([
      run(remote, ['task', 'new', '--project', 'site', '--brief', 'Same', '--json']),
      run(remote, ['task', 'new', '--project', 'site', '--brief', 'Same', '--json']),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(new Set([JSON.parse(a.out).task, JSON.parse(b.out).task])).toEqual(new Set(['same', 'same-2']));
    expect((await stateOf()).tasks).toHaveLength(2);
  });

  it('while the app is open and another process writes the same store at once, nothing is lost', async () => {
    const remote = await serve();
    const seen: ShellState[] = [];
    appStore.onChanged((s) => seen.push(s));
    const stop = appStore.watch(50);
    try {
      const local = service(new ShellStore(home));
      const results = await Promise.all([
        ...[1, 2, 3].map(() => run(remote, ['task', 'new', '--project', 'site', '--brief', 'Same', '--json'])),
        ...[1, 2, 3].map(() => run(local, ['task', 'new', '--project', 'site', '--brief', 'Same', '--json'])),
      ]);
      expect(results.map((r) => r.code), results.map((r) => r.err).join('\n')).toEqual([0, 0, 0, 0, 0, 0]);
      const ids = results.map((r) => JSON.parse(r.out).task as string);
      expect(new Set(ids).size).toBe(6);
      expect((await stateOf()).tasks.map((t) => t.id).sort()).toEqual([...ids].sort());
      // The open app sees all six, and its page is told.
      expect((await app.state()).tasks).toHaveLength(6);
      await expect.poll(() => seen.at(-1)?.tasks.length ?? 0).toBe(6);
    } finally {
      stop();
    }
  });
});

describe('task show, ls, feed and changes', () => {
  it('shows the state, sessions and open asks; stop, resume and finish change it', async () => {
    await run(app, ['task', 'new', '--project', 'site', '--brief', 'Fix it']);
    d.sessions.push(makeSession('fix-it-api', { labels: { 'hopp.task': 'fix-it', 'hopp.role': 'worker' }, state: 'running' }));
    d.asks.push({ id: 7, from: 'fix-it', labels: {}, body: 'Which colour?', options: ['Red', 'Blue'], attachments: null, status: 'open', created_at: 5 } as never);
    const show = await run(app, ['task', 'show', 'fix-it']);
    expect(show.out).toContain('state:        running');
    expect(show.out).toContain('sessions:     fix-it (running), fix-it-api (running)');
    expect(show.out).toContain('#7 from fix-it: Which colour? [Red / Blue]');
    expect(show.out).toContain('started by:   the human');
    expect((await run(app, ['task', 'stop', 'fix-it'])).code).toBe(0);
    expect((await run(app, ['task', 'ls'])).out).toMatch(/fix-it\s+site\s+killed/);
    expect((await run(app, ['task', 'finish', 'fix-it'])).out).toBe('finished fix-it');
    expect((await run(app, ['task', 'ls'])).out).toMatch(/No active tasks/);
    expect((await run(app, ['task', 'ls', '--all'])).out).toMatch(/fix-it\s+site\s+finished/);
    const resume = await run(app, ['task', 'resume', 'fix-it']);
    expect(resume.code).toBe(1);
    expect(resume.err).toMatch(/finished task cannot be resumed/);
  });

  it('add-worker adds profiles to a task, says which were new, and refuses no --worker', async () => {
    await run(app, ['task', 'new', '--project', 'site', '--brief', 'Fix it']);
    const add = await run(app, ['task', 'add-worker', 'fix-it', '--worker', 'cheap']);
    expect(add.code, add.err).toBe(0);
    expect(add.out).toBe('added to fix-it: cheap');
    expect((await stateOf()).tasks[0]!).toMatchObject({ workerProfiles: ['sonnet', 'cheap'], addedWorkerProfiles: ['cheap'] });
    expect(d.messages.filter((m) => m.to === 'fix-it').at(-1)!.body).toContain('`cheap` (deepseek)');
    const again = await run(app, ['task', 'add-worker', 'fix-it', '--worker', 'cheap']);
    expect(again.out).toBe('fix-it already has: cheap');
    // Through the open app, with --json.
    const remote = await serve();
    const json = await run(remote, ['task', 'add-worker', 'fix-it', '--worker', 'cheap', '--worker', 'sonnet', '--json']);
    expect(json.code, json.err).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ task: 'fix-it', added: [], workerProfiles: ['sonnet', 'cheap'] });
    const usage = await run(app, ['task', 'add-worker', 'fix-it']);
    expect(usage.code).toBe(3);
    expect(usage.err).toMatch(/--worker/);
    const off = await run(app, ['task', 'add-worker', 'fix-it', '--worker', 'off']);
    expect(off.code).toBe(1);
    expect(off.err).toMatch(/"off" is not an enabled profile/);
  });

  it('add-worker --json lists the added profiles', async () => {
    await run(app, ['task', 'new', '--project', 'site', '--brief', 'Fix it']);
    const json = await run(app, ['task', 'add-worker', 'fix-it', '--worker', 'cheap', '--json']);
    expect(JSON.parse(json.out)).toEqual({ task: 'fix-it', added: ['cheap'], workerProfiles: ['sonnet', 'cheap'] });
  });

  it('says the daemon is not running with exit 2', async () => {
    await d.stop();
    const r = await run(app, ['task', 'ls']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/daemon is not running/);
  });
});

describe('the shell socket', () => {
  it('is the user\'s alone and serves only the CLI methods', async () => {
    await serve();
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const remote = new RemoteShell(socket) as unknown as { call: (m: string, a: unknown[]) => Promise<unknown> };
    await expect(remote.call('pickFolder', [])).rejects.toThrow(/no such method/);
    await expect(remote.call('removeProject', ['site'])).rejects.toThrow(/no such method/);
    // A bad argument is a Result error, as for the page.
    expect(await remote.call('createTask', [{ projectSlug: 7 }])).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('replaces a leftover socket file, and refuses to start twice on one home', async () => {
    writeFileSync(socket, '');
    await serve();
    expect(await appAnswers(socket)).toBe(true);
    await expect(serveShell(app, socket)).rejects.toThrow(/served by another process/);
  });

  it('goes to a private folder under /tmp when the app home is too long for a socket', async () => {
    // A short base of its own (the temp folder's path is long on macOS).
    const base = mkdtempSync('/tmp/hs-');
    onTestFinished(() => rmSync(base, { recursive: true, force: true }));
    const long = join(root, 'x'.repeat(120));
    const p = shellSocketPath(long, base);
    expect(p).toMatch(new RegExp(`^${base}/hopp-${process.getuid!()}/shell-[0-9a-f]{16}\\.sock$`));
    expect(shellSocketPath(long, base)).toBe(p);
    expect(shellSocketPath('/short')).toBe('/short/shell.sock');
    // Served there, in a folder only this user can enter.
    server = await serveShell(app, p);
    expect(statSync(join(base, `hopp-${process.getuid!()}`)).mode & 0o777).toBe(0o700);
    expect(await appAnswers(p)).toBe(true);
    await server.close();
    server = null;
    // A folder others can enter is refused.
    const other = shellSocketPath(join(root, 'y'.repeat(120)), join(base, 'shared'));
    mkdirSync(dirname(other), { recursive: true, mode: 0o755 });
    chmodSync(dirname(other), 0o755);
    expect(await privateDirOk(other, true)).toBe(false);
    await expect(serveShell(app, other)).rejects.toThrow(/not a folder of this user alone/);
  });
});
