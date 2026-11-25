// Lessons by kind: a launch never shows agents their project's lessons, and
// how the human sorts lessons and moves one into Guardrails.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeLesson, makeProfile } from '../../../test/fakeDaemon';
import type { Lesson } from '../../shared/shell';
import { DaemonClient } from '../daemon/client';
import { makeRunner, type Runner } from './exec';
import { ShellService } from './service';
import { projectLessonsCommand, triageLessonsBrief } from './startText';
import { ShellStore } from './store';

const projectLesson = (id: number, slug: string, body = `fact ${id}`, over: Partial<Lesson> = {}): Lesson =>
  makeLesson(id, { body, labels: { 'hopp.project': slug, 'hopp.about': 'project' }, ...over });

describe('triageLessonsBrief', () => {
  it('lists the lessons, says where knowledge goes, and how to treat lessons about hopp', () => {
    const b = triageLessonsBrief('site');
    expect(b).toContain(projectLessonsCommand('site'));
    expect(b).toContain('`hopp lessons close <id>`');
    expect(b).toContain('`hopp lessons label <id> hopp.about=hopp`');
    expect(b).toContain('list what you did with each lesson');
    expect(b).toContain('a note about one task and not a defect of the context');
  });
});

// The service against a fake daemon, in a temp HOPP_HOME.
let root: string;
let home: string;
let d: FakeDaemon;
let svc: ShellService;
const hopp: Runner = async () => ({ stdout: '## Tools\n', stderr: '' });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hopp-lessons-')));
  home = join(root, 'h');
  d = new FakeDaemon(join(root, 'd'));
  mkdirSync(d.home, { recursive: true });
  await d.start();
  d.profiles = [makeProfile('sonnet')];
  svc = new ShellService({ home, store: new ShellStore(home), client: new DaemonClient(d.socketPath), git: makeRunner('git', () => process.env), hopp, pickFolder: async () => null });
  for (const name of ['Site', 'Shop']) {
    const r = await svc.createProject({ name, description: '', orchestratorRepo: null, workerRepos: [], guardrails: name === 'Site' ? 'No force push.' : '' });
    if (!r.ok) throw new Error(r.error.message);
  }
});
afterEach(async () => {
  await d.stop();
  rmSync(root, { recursive: true, force: true });
});

const launch = async () => {
  const r = await svc.createTask({ projectSlug: 'site', brief: 'Fix it', orchestratorProfile: 'sonnet', workerProfiles: ['sonnet'] });
  if (!r.ok) throw new Error(r.error.message);
  return { orch: String(d.created.at(-1)!['system_prompt']), worker: readFileSync(join(home, 'shell', 'tasks', r.value.id, 'worker-claude-code.md'), 'utf8') };
};

describe('a launch shows no lessons', () => {
  it('neither the orchestrator nor a worker gets the project\'s open lessons', async () => {
    d.lessons = [
      projectLesson(1, 'site', 'old site fact'),
      makeLesson(4, { body: 'hopp send lost my text', labels: { 'hopp.project': 'site', 'hopp.about': 'hopp' } }),
      projectLesson(6, 'site', 'new site fact'),
    ];
    for (const t of Object.values(await launch())) {
      for (const no of ['old site fact', 'new site fact', 'hopp send lost', 'Lessons from earlier tasks']) expect(t).not.toContain(no);
      expect(t).toContain('`hopp lesson --label hopp.about=project');
    }
  });
});

describe('sorting lessons', () => {
  it('relabels about and project, and back again', async () => {
    d.lessons = [makeLesson(1, { labels: { 'hopp.role': 'worker' } })];
    expect(await svc.setLessonAbout(1, 'project')).toEqual({ ok: true, value: null });
    expect(await svc.setLessonProject(1, 'site')).toEqual({ ok: true, value: null });
    expect(d.lessons[0]!.labels).toEqual({ 'hopp.role': 'worker', 'hopp.about': 'project', 'hopp.project': 'site' });
    await svc.setLessonAbout(1, null);
    await svc.setLessonProject(1, null);
    expect(d.lessons[0]!.labels).toEqual({ 'hopp.role': 'worker' });
    const bad = await svc.setLessonProject(1, 'nope');
    expect(!bad.ok && bad.error.code).toBe('project_not_found');
    const gone = await svc.setLessonAbout(99, 'hopp');
    expect(!gone.ok && gone.error.code).toBe('lesson_not_found');
  });

  it('moves a lesson into its project\'s Guardrails once, and closes it', async () => {
    d.lessons = [projectLesson(7, 'site', 'pnpm --filter ignores the file\nrun vitest directly')];
    expect(await svc.lessonToGuardrails(7)).toEqual({ ok: true, value: null });
    const g = () => svc.state().then((s) => s.projects.find((p) => p.slug === 'site')!.guardrails);
    expect(await g()).toBe('No force push.\n- pnpm --filter ignores the file\n  run vitest directly (lesson #7)');
    expect(d.lessons[0]!.status).toBe('closed');
    expect(await svc.lessonToGuardrails(7)).toEqual({ ok: true, value: null });
    expect(await g()).toBe('No force push.\n- pnpm --filter ignores the file\n  run vitest directly (lesson #7)');
    // A lesson about no project cannot go to Guardrails.
    d.lessons.push(makeLesson(8, { labels: {} }));
    const r = await svc.lessonToGuardrails(8);
    expect(!r.ok && r.error.code).toBe('lesson_no_project');
    const r2 = await svc.lessonToGuardrails(99);
    expect(!r2.ok && r2.error.code).toBe('lesson_not_found');
  });

  it('gives the triage brief of a project', async () => {
    expect(await svc.triageLessonsBrief('shop')).toBe(triageLessonsBrief('shop'));
  });
});
