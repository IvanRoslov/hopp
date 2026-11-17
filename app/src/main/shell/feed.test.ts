import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeAsk, makeProfile, makeSession } from '../../../test/fakeDaemon';
import type { PipelineInput, Post } from '../../shared/shell';
import { DaemonClient } from '../daemon/client';
import { makeRunner, type Runner } from './exec';
import { starterPipelines, validatePipeline } from './pipelines';
import { ShellService } from './service';
import { pipelineLayer } from './startText';
import { ShellStore } from './store';

let root: string;
let home: string;
let d: FakeDaemon;
let store: ShellStore;
let svc: ShellService;

const hopp: Runner = async (args) => ({ stdout: args[1] === 'prompt' ? '## Tools\n' : '{}', stderr: '' });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-feed-')));
  home = join(root, 'home');
  mkdirSync(home);
  d = new FakeDaemon(join(root, 'daemon'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('p')];
  store = new ShellStore(home);
  svc = new ShellService({ home, store, client: new DaemonClient(d.socketPath), git: makeRunner('git', () => process.env), hopp, pickFolder: async () => null, now: () => 500 });
});
afterEach(async () => {
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

const stage = (name: string, over: Partial<PipelineInput['stages'][number]> = {}) => ({ name, does: 'does ' + name, result: 'result ' + name, substages: false, approval: true, ...over });

async function taskWithPipeline() {
  await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
  const p = await svc.createPipeline({ name: 'Two', stages: [stage('Spec'), stage('Build', { substages: true, approval: false })] });
  if (!p.ok) throw new Error('pipeline');
  const t = await svc.createTask({ projectSlug: 'site', brief: 'Make it', orchestratorProfile: 'p', workerProfiles: [], pipelineId: p.value.id });
  if (!t.ok) throw new Error(JSON.stringify(t.error));
  return { pipeline: p.value, task: t.value };
}

describe('pipelines', () => {
  it('validates names and stages by field', () => {
    const others = starterPipelines(1);
    const cases: [PipelineInput, string, string][] = [
      [{ name: ' ', stages: [stage('a')] }, 'name', 'name_required'],
      [{ name: 'development', stages: [stage('a')] }, 'name', 'name_taken'],
      [{ name: 'X', stages: [] }, 'stages', 'stages_required'],
      [{ name: 'X', stages: [stage('a'), stage('')] }, 'stages[1].name', 'stage_name_required'],
      [{ name: 'X', stages: [stage('A'), stage('a')] }, 'stages[1].name', 'stage_name_taken'],
    ];
    for (const [input, field, code] of cases) {
      const r = validatePipeline(input, others, 1);
      expect(!r.ok && [r.error.field, r.error.code], JSON.stringify(input)).toEqual([field, code]);
    }
  });

  it('keeps stage ids through renames and moves, and gives new stages fresh ids', async () => {
    const r = await svc.createPipeline({ name: 'Video', stages: [stage('Script'), stage('Script!')] });
    expect(r.ok && r.value.stages.map((s) => s.id)).toEqual(['script', 'script-2']);
    if (!r.ok) return;
    const [a, b] = r.value.stages;
    const u = await svc.updatePipeline(r.value.id, {
      name: 'Video 2',
      stages: [{ ...b!, name: 'Storyboard' }, stage('Script'), { ...a!, name: 'Renamed' }],
    });
    expect(u.ok && u.value).toMatchObject({ id: 'video', name: 'Video 2', createdAt: 500 });
    expect(u.ok && u.value.stages.map((s) => [s.id, s.name])).toEqual([['script-2', 'Storyboard'], ['script-3', 'Script'], ['script', 'Renamed']]);
    expect((await svc.removePipeline('video')).ok).toBe(true);
    expect((await svc.removePipeline('video')).ok).toBe(false);
  });

  it('seeds the three starter pipelines once, and never again after they are removed', async () => {
    expect(await svc.seedPipelines()).toBe(true);
    const names = (await svc.state()).pipelines.map((p) => p.name);
    expect(names).toEqual(['Development', 'Landing page', 'Promo video']);
    for (const p of (await svc.state()).pipelines) await svc.removePipeline(p.id);
    expect(await svc.seedPipelines()).toBe(false);
    expect(await new ShellService({ home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git: makeRunner('git', () => process.env), hopp, pickFolder: async () => null }).seedPipelines()).toBe(false);
    expect((await new ShellStore(home).read()).pipelines).toEqual([]);
  });

  it('does not seed a store that already has pipelines', async () => {
    await svc.createPipeline({ name: 'Mine', stages: [stage('a')] });
    await svc.seedPipelines();
    expect((await svc.state()).pipelines.map((p) => p.name)).toEqual(['Mine']);
  });

  it('starter pipelines: Promo video scenes have substages', () => {
    const video = starterPipelines(1).find((p) => p.name === 'Promo video')!;
    expect(video.stages.map((s) => s.name)).toEqual(['Script', 'Storyboard', 'Scenes', 'Assembly']);
    expect(video.stages.find((s) => s.name === 'Scenes')!.substages).toBe(true);
  });
});

describe('a task with a pipeline', () => {
  it('copies the pipeline at launch; later edits leave the task alone', async () => {
    const { pipeline, task } = await taskWithPipeline();
    expect(task.pipeline).toEqual(pipeline);
    await svc.updatePipeline(pipeline.id, { name: 'Changed', stages: [stage('Only')] });
    expect((await svc.state()).tasks[0]!.pipeline!.name).toBe('Two');
  });

  it('puts the pipeline layer into the orchestrator start text', async () => {
    await taskWithPipeline();
    const sp = String(d.created.at(-1)!['system_prompt']);
    expect(sp).toContain('# Pipeline: Two');
    expect(sp).toContain('**Spec** — stage id `spec`; waits for the human\'s approval; no substages.');
    expect(sp).toContain('**Build** — stage id `build`; passes without approval; may have substages.');
    expect(sp).toContain('hopp post --label hopp.stage=<id> --label hopp.event=stage_started');
    expect(sp).toContain('hopp artifact publish <file> --name <name> --label hopp.stage=<id>');
    expect(sp).toContain('--label hopp.kind=submission --option Accept --option Return --attach <name>@<version>');
    expect(sp).toContain('hopp.substage=<slug>');
    // Live run: "its two labels" was read as "on the declaring post only".
    expect(sp).not.toContain('its two labels');
    expect(sp).toContain('put `--label hopp.substage=<slug>` and `--label "hopp.substage_title=<title>"` on every post and artifact of that substage');
    expect(sp).not.toContain('ready for review" --option Accept --option Revise');
    expect(sp.indexOf('# Pipeline')).toBeLessThan(sp.indexOf('## Tools'));
  });

  it('an unknown pipeline is a field error', async () => {
    await svc.createProject({ name: 'Site', description: '', orchestratorRepo: null, workerRepos: [], guardrails: '' });
    const r = await svc.createTask({ projectSlug: 'site', brief: 'x', orchestratorProfile: 'p', workerProfiles: [], pipelineId: 'ghost' });
    expect(!r.ok && r.error.field).toBe('pipelineId');
  });

  it('the pipeline layer leaves out substage commands when no stage has substages', () => {
    const t = pipelineLayer({ id: 'x', name: 'X', createdAt: 1, updatedAt: 1, stages: [{ id: 'a', name: 'A', does: '', result: '', substages: false, approval: true }] });
    expect(t).not.toContain('hopp.substage=');
  });
});

describe('the feed', () => {
  it('reads the task\'s posts, all its asks, and every artifact version of its scope', async () => {
    const { task } = await taskWithPipeline();
    const mine = { 'hopp.task': task.id };
    const post = (id: number, labels: Record<string, string>, ts = id): Post => ({ id, from: task.id, labels, body: 'b' + id, attachments: [], created_at: ts });
    d.posts = [post(1, mine, 5), post(2, { 'hopp.task': 'other' }), post(3, mine, 4)];
    d.asks = [makeAsk(10, task.id, { labels: mine, status: 'answered' }), makeAsk(11, 'x', { labels: { 'hopp.task': 'other' } })];
    d.artifacts = [
      { id: 1, scope: task.id, name: 'spec', version: 1, filename: 's.md', mime: 'text/markdown', size: 1, sha256: '', from: task.id, labels: {}, created_at: 1, path: '/x' },
      { id: 2, scope: task.id, name: 'spec', version: 2, filename: 's.md', mime: 'text/markdown', size: 1, sha256: '', from: task.id, labels: {}, created_at: 2, path: '/x' },
      { id: 3, scope: 'other', name: 'z', version: 1, filename: 'z', mime: '', size: 1, sha256: '', from: '', labels: {}, created_at: 1, path: '/x' },
    ];
    const f = await svc.taskFeed(task.id);
    expect(f.posts.map((p) => p.id)).toEqual([3, 1]);
    expect(f.asks.map((a) => a.id)).toEqual([10]);
    expect(f.artifacts.map((a) => [a.name, a.version])).toEqual([['spec', 1], ['spec', 2]]);
    expect(f.artifacts[0]).not.toHaveProperty('path');
    await expect(svc.taskFeed('nope')).rejects.toThrow();
  });

  it('includes asks from the task\'s sessions even when the daemon did not copy the task label', async () => {
    const { task } = await taskWithPipeline();
    d.sessions.push(makeSession('w1', { parent: task.sessionId, labels: { 'hopp.task': task.id } }));
    d.sessions.push(makeSession('stranger', { labels: { 'hopp.task': 'other' } }));
    d.asks = [
      makeAsk(1, task.sessionId, { labels: { 'hopp.stage': 'spec', 'hopp.kind': 'submission' } }),
      makeAsk(2, 'w1', { labels: {} }),
      makeAsk(3, 'stranger', { labels: {} }),
      makeAsk(4, 'x', { labels: { 'hopp.task': task.id } }),
    ];
    expect((await svc.taskFeed(task.id)).asks.map((a) => a.id)).toEqual([1, 2, 4]);
  });

  it('pages through more than one batch of posts', async () => {
    const { task } = await taskWithPipeline();
    d.posts = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, from: '', labels: { 'hopp.task': task.id }, body: 'x', attachments: [], created_at: 1 }));
    expect((await svc.taskFeed(task.id)).posts).toHaveLength(1200);
  });

  it('the human\'s line goes to the orchestrator and into the feed', async () => {
    const { task } = await taskWithPipeline();
    const r = await svc.postToTask(task.id, '  Use the blue logo  ', 'spec');
    expect(r.ok && r.value).toMatchObject({ from: '', body: 'Use the blue logo', labels: { 'hopp.project': 'site', 'hopp.task': task.id, 'hopp.stage': 'spec' } });
    expect(d.messages).toEqual([{ id: 1, to: task.id, body: 'Use the blue logo' }]);
    expect((await svc.postToTask(task.id, ' ')).ok).toBe(false);
    expect((await svc.postToTask(task.id, 'x', 'ghost')).ok).toBe(false);
    await svc.stopTask(task.id);
    const stopped = await svc.postToTask(task.id, 'hello');
    expect(!stopped.ok && stopped.error.code).toBe('orchestrator_not_running');
    expect(d.posts).toHaveLength(1);
  });

  it('a line sent but not recorded in the feed is not reported as a failure', async () => {
    const { task } = await taskWithPipeline();
    d.override.set('POST /v1/posts', { status: 500, body: { error: { code: 'internal_error', message: 'disk full' } } });
    const r = await svc.postToTask(task.id, 'Use the blue logo');
    expect(r.ok && r.value).toMatchObject({ id: 0, from: '', body: 'Use the blue logo' });
    expect(d.messages).toHaveLength(1);
  });

  it('answers a submission with Accept, or Return with what to fix', async () => {
    d.asks = [makeAsk(1, 's', { options: ['Accept', 'Return'] }), makeAsk(2, 's', { options: ['Accept', 'Return'] })];
    expect((await svc.answerSubmission(1, { choice: 'Accept' })).ok).toBe(true);
    expect(d.asks[0]).toMatchObject({ status: 'answered', choice: 'Accept' });
    const empty = await svc.answerSubmission(2, { choice: 'Return', text: ' ' });
    expect(!empty.ok && empty.error.field).toBe('text');
    expect((await svc.answerSubmission(2, { choice: 'Return', text: 'Fix the title' })).ok).toBe(true);
    expect(d.asks[1]).toMatchObject({ choice: 'Return', answer: 'Fix the title' });
    const again = await svc.answerSubmission(2, { choice: 'Accept' });
    expect(!again.ok && again.error.code).toBe('ask_closed');
  });

  it('names the task of feed events from the item labels, then the session labels', () => {
    expect(svc.feedTaskOf({ id: 1, ts: 1, type: 'post.added', data: { post_labels: { 'hopp.task': 't1' } } })).toBe('t1');
    expect(svc.feedTaskOf({ id: 1, ts: 1, type: 'ask.answered', data: { ask_labels: {}, labels: { 'hopp.task': 't2' } } })).toBe('t2');
    expect(svc.feedTaskOf({ id: 1, ts: 1, type: 'artifact.published', data: { artifact_labels: { 'hopp.task': 't3' } } })).toBe('t3');
    expect(svc.feedTaskOf({ id: 1, ts: 1, type: 'session.spawned', data: { labels: { 'hopp.task': 't4' } } })).toBeNull();
    expect(svc.feedTaskOf({ id: 1, ts: 1, type: 'post.added', data: {} })).toBeNull();
  });
});

describe('artifact files', () => {
  const add = (id: number, path: string, mime = 'text/plain') =>
    d.artifacts.push({ id, scope: 's', name: 'n' + id, version: 1, filename: 'f', mime, size: 1, sha256: '', from: '', labels: {}, created_at: 1, path });

  it('serves text only from inside $HOPP_HOME/artifacts', async () => {
    const dir = join(home, 'artifacts', 's', 'n1', 'v1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.md'), '# Spec\n');
    chmodSync(join(dir, 'f.md'), 0o444);
    add(1, join(dir, 'f.md'), 'text/markdown');
    expect(await svc.artifactText(1)).toEqual({ ok: true, value: '# Spec\n' });
    expect((await svc.artifactFile(1)).mime).toBe('text/markdown');

    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'secret');
    add(2, outside);
    expect((await svc.artifactText(2)).ok).toBe(false);
    await expect(svc.artifactFile(2)).rejects.toThrow(/outside/);

    symlinkSync(outside, join(dir, 'link'));
    add(3, join(dir, 'link'));
    await expect(svc.artifactFile(3)).rejects.toThrow(/outside/);
    add(4, join(home, 'artifacts', 's', 'n1', 'v1', '..', '..', '..', '..', 'secret-dir'));
    expect((await svc.artifactText(4)).ok).toBe(false);
  });

  it('refuses binary and large files as text', async () => {
    const dir = join(home, 'artifacts', 's');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0, 1]));
    add(1, join(dir, 'img.png'), 'image/png');
    expect((await svc.artifactText(1)).ok).toBe(false);
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    add(2, join(dir, 'big.txt'));
    const r = await svc.artifactText(2);
    expect(!r.ok && r.error.code).toBe('too_large');
  });
});
