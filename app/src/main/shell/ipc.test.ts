import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeProfile } from '../../../test/fakeDaemon';
import { SHELL_CHANGED, SHELL_METHODS, shellChannel } from '../../shared/ipc';
import type { ShellBridge } from '../../shared/shell';
import { DaemonClient } from '../daemon/client';
import { makeRunner } from './exec';
import { callShell, registerShellIpc } from './ipc';
import { ShellService } from './service';
import { ShellStore } from './store';

let home: string;
let d: FakeDaemon;
let svc: ShellService;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hopp-ipc-'));
  d = new FakeDaemon();
  await d.start();
  d.profiles = [makeProfile('p')];
  svc = new ShellService({
    home, store: new ShellStore(home), client: new DaemonClient(d.socketPath),
    git: makeRunner('git', () => process.env), hopp: async () => ({ stdout: '', stderr: '' }), pickFolder: async () => null,
  });
});
afterEach(async () => {
  await d.dispose();
  rmSync(home, { recursive: true, force: true });
});

describe('shell IPC', () => {
  it('covers every bridge method but the listeners and artifactUrl', () => {
    const bridgeKeys: (keyof ShellBridge)[] = [
      'state', 'onChanged', 'createProject', 'updateProject', 'removeProject', 'pickFolder', 'listProfiles',
      'createTask', 'stopTask', 'resumeTask', 'finishTask', 'hideTask', 'createAgent', 'startAgent', 'stopAgent',
      'removeAgent', 'agentMail', 'waiting', 'listTools', 'toolUsage', 'setToolEnabled', 'toolRules', 'setToolRules',
      'listLessons', 'closeLesson', 'createPipeline', 'updatePipeline', 'removePipeline', 'taskFeed', 'onFeedChanged',
      'postToTask', 'answerSubmission', 'artifactUrl', 'artifactText',
    ];
    const local = ['onChanged', 'onFeedChanged', 'artifactUrl'];
    expect([...SHELL_METHODS].sort()).toEqual(bridgeKeys.filter((k) => !local.includes(k)).sort());
  });

  it('answers a malformed call to a Result method with a bad_request result', async () => {
    for (const [m, args] of [
      ['createProject', [null]],
      ['createProject', [{ name: 5 }]],
      ['createProject', [{ name: 'x', workerRepos: 'nope' }]],
      ['createTask', [{ projectSlug: 'x' }]],
      ['createTask', [{ projectSlug: 'x', brief: 'b', orchestratorProfile: 'p', workerProfiles: [1] }]],
      ['stopTask', [{}]],
      ['setToolEnabled', ['t', 'yes']],
      ['closeLesson', ['1']],
      ['closeLesson', [1.5]],
      ['createAgent', [['a']]],
      ['setToolRules', [undefined]],
      ['createPipeline', [{ name: 'x', stages: 'no' }]],
      ['createPipeline', [{ name: 'x', stages: [{ name: 'a', approval: 'yes' }] }]],
      ['updatePipeline', [1, { name: 'x', stages: [] }]],
      ['postToTask', ['t', 5]],
      ['answerSubmission', [1, { choice: 'Maybe' }]],
      ['answerSubmission', [1, { choice: 'Return' }]],
      ['artifactText', [-1]],
    ] as [string, unknown[]][]) {
      const r = (await callShell(svc, m, args)) as { ok: boolean; error?: { code: string } };
      expect([m, r.ok, r.error?.code]).toEqual([m, false, 'bad_request']);
    }
  });

  it('rejects a malformed call to a plain method, and an unknown method', async () => {
    await expect(callShell(svc, 'listLessons', ['everything'])).rejects.toThrow(/status/);
    await expect(callShell(svc, 'toolUsage', [42])).rejects.toThrow(/text/);
    await expect(callShell(svc, 'taskFeed', [null])).rejects.toThrow(/text/);
    await expect(callShell(svc, 'constructor', [])).rejects.toThrow(/unknown/);
    await expect(callShell(svc, '__proto__', [])).rejects.toThrow(/unknown/);
  });

  it('turns a daemon outage into a result, not a throw', async () => {
    await d.stop();
    const r = (await callShell(svc, 'stopTask', ['x'])) as { ok: boolean };
    expect(r.ok).toBe(false);
    const a = (await callShell(svc, 'createAgent', [{ name: 'cto', profile: 'p', dir: home }])) as { ok: boolean; error: { code: string } };
    expect(a.error.code).toBe('daemon_unavailable');
  });

  it('a good call works and store changes are forwarded', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const sent: [string, unknown][] = [];
    registerShellIpc({ handle: (c, f) => handlers.set(c, f) }, svc, (c, s) => sent.push([c, s]));
    expect(handlers.size).toBe(SHELL_METHODS.length);
    const r = (await handlers.get(shellChannel('createProject'))!({}, {
      name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '',
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(sent.map(([c]) => c)).toEqual([SHELL_CHANGED]);
    expect(await handlers.get(shellChannel('state'))!({})).toMatchObject({ projects: [{ slug: 'site' }] });
  });
});
