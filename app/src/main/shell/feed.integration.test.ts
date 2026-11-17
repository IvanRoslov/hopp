// Runs the real daemon, built from daemon/ into a temp folder, on a temp
// HOPP_HOME, and checks the feed and artifact calls against it. No agent is
// launched: posts, asks and artifacts are made without a session. Skipped
// when Go is not installed.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '../daemon/client';
import { makeRunner } from './exec';
import { ShellService } from './service';
import { ShellStore } from './store';

const hasGo = spawnSync('go', ['version']).status === 0;

describe.skipIf(!hasGo)('the feed against the real daemon', () => {
  let root: string;
  let home: string;
  let daemon: ChildProcess;
  let client: DaemonClient;
  let svc: ShellService;
  let store: ShellStore;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hfi-')));
    home = join(root, 'h');
    const bin = join(root, 'hopp');
    execFileSync('go', ['build', '-o', bin, './cmd/hopp'], { cwd: resolve(import.meta.dirname, '../../../../daemon'), stdio: 'ignore' });
    const env = { ...process.env, HOPP_HOME: home, HOPP_SESSION_ID: '', HOPP_SOCKET: '' };
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
    store = new ShellStore(home);
    svc = new ShellService({
      home, store, client, git: makeRunner('git', () => env), hopp: makeRunner(bin, () => env), pickFolder: async () => null,
    });
    // A task as the store keeps it; its orchestrator session "orch" is never
    // launched, so its artifacts are published with an explicit scope.
    await store.update((s) => {
      s.tasks.push({
        id: 'demo', projectSlug: 'site', title: 'Demo', brief: 'b', sessionId: 'orch', dir: root, branch: null,
        orchestratorProfile: 'p', workerProfiles: [], pipeline: null, base: null, startedBy: null, status: 'active', hidden: false, createdAt: 1, finishedAt: 0,
      });
    });
  }, 180_000);

  afterAll(async () => {
    daemon?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true });
  });

  it('reads posts, asks and artifact versions of the task, answers a submission, and serves artifact text', async () => {
    const labels = { 'hopp.project': 'site', 'hopp.task': 'demo', 'hopp.stage': 'spec' };
    await client.createPost({ from: '', body: 'Starting the spec', labels: { ...labels, 'hopp.event': 'stage_started' } });
    await client.createPost({ from: '', body: 'not ours', labels: { 'hopp.task': 'other' } });

    const file = join(root, 'spec.md');
    writeFileSync(file, '# Spec v1\n');
    const call = (b: unknown) =>
      (client as unknown as { call: (m: string, p: string, b: unknown) => Promise<{ name: string; version: number }> }).call('POST', '/v1/artifacts', b);
    expect((await call({ from: '', scope: 'orch', name: 'spec', path: file, labels })).version).toBe(1);
    writeFileSync(file, '# Spec v2\n');
    expect((await call({ from: '', scope: 'orch', name: 'spec', path: file, labels })).version).toBe(2);

    const ask = await (client as unknown as { call: (m: string, p: string, b: unknown) => Promise<{ id: number }> }).call('POST', '/v1/asks', {
      from: '', body: 'Spec is ready', options: ['Accept', 'Return'], attachments: ['spec@2'], labels: { ...labels, 'hopp.kind': 'submission' },
    });

    const f = await svc.taskFeed('demo');
    expect(f.posts.map((p) => p.body)).toEqual(['Starting the spec']);
    expect(f.asks.map((a) => [a.id, a.status])).toEqual([[ask.id, 'open']]);
    expect(f.artifacts.map((a) => `${a.name}@${a.version}`)).toEqual(['spec@1', 'spec@2']);
    expect(f.artifacts[0]).not.toHaveProperty('path');

    const r = await svc.answerSubmission(ask.id, { choice: 'Return', text: 'Add the goals' });
    expect(r.ok && r.value).toMatchObject({ status: 'answered', choice: 'Return', answer: 'Add the goals' });
    expect((await svc.taskFeed('demo')).asks[0]).toMatchObject({ status: 'answered', choice: 'Return' });

    expect(await svc.artifactText(f.artifacts[0]!.id)).toEqual({ ok: true, value: '# Spec v1\n' });
    const stored = await svc.artifactFile(f.artifacts[1]!.id);
    expect(stored.path.startsWith(realpathSync(join(home, 'artifacts')))).toBe(true);
    expect(existsSync(stored.path)).toBe(true);
  });

  it('names the task of the daemon\'s own feed events', async () => {
    const evs = await (client as unknown as { call: (m: string, p: string) => Promise<{ events: { id: number; ts: number; type: string; data: Record<string, unknown> }[] }> }).call('GET', '/v1/events?limit=100');
    const feedEvents = evs.events.filter((e) => ['post.added', 'artifact.published', 'ask.created', 'ask.answered'].includes(e.type));
    expect(feedEvents.length).toBeGreaterThanOrEqual(5);
    const tasks = feedEvents.map((e) => svc.feedTaskOf(e));
    expect(tasks.filter((t) => t === 'demo').length).toBeGreaterThanOrEqual(4);
    expect(tasks).toContain('other');
  });
});
