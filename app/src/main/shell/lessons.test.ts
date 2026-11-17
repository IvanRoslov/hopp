// Lessons by kind: what a launch tells agents about their project's open
// lessons, and how the human sorts lessons and moves one into Guardrails.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeLesson, makeProfile } from '../../../test/fakeDaemon';
import type { Lesson } from '../../shared/shell';
import { DaemonClient } from '../daemon/client';
import { makeRunner, type Runner } from './exec';
import { ShellService } from './service';
import { LESSONS_MAX, projectLessonsCommand, projectLessonsLayer, triageLessonsBrief } from './startText';
import { ShellStore } from './store';

const projectLesson = (id: number, slug: string, body = `fact ${id}`, over: Partial<Lesson> = {}): Lesson =>
  makeLesson(id, { body, labels: { 'hopp.project': slug, 'hopp.about': 'project' }, ...over });

describe('projectLessonsLayer', () => {
  it('says nothing when there are none', () => {
    expect(projectLessonsLayer('site', [])).toBeUndefined();
  });

  it('lists each with its id, how to close one and how to list them all', () => {
    const t = projectLessonsLayer('site', [projectLesson(9, 'site', 'crane needs DOCKER_CONFIG\nset it to an empty dir'), projectLesson(4, 'site'), projectLesson(2, 'site')])!;
    expect(t).toContain('## Lessons from earlier tasks in this project');
    expect(t).toContain('- #9 crane needs DOCKER_CONFIG\n  set it to an empty dir\n- #4 fact 4\n- #2 fact 2');
    expect(t).toContain('close it with `hopp lessons close <id>`');
    expect(t).toContain('do not close a lesson you only read');
    expect(t).toContain('`hopp lessons --label hopp.project=site --label hopp.about=project --full`');
    expect(t).not.toContain('more:');
  });

  it('caps a long list and counts the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => projectLesson(40 - i, 'site'));
    const t = projectLessonsLayer('site', many)!;
    expect(t.match(/^- #/gm)).toHaveLength(LESSONS_MAX);
    expect(t).toContain(`20 more: \`${projectLessonsCommand('site')}\``);
    // And by size: long lessons stop before ~4 KB.
    const long = Array.from({ length: 10 }, (_, i) => projectLesson(i + 1, 'site', 'x'.repeat(1000)));
    const t2 = projectLessonsLayer('site', long)!;
    expect(t2.match(/^- #/gm)).toHaveLength(4);
    expect(t2).toContain('6 more:');
  });
});

describe('triageLessonsBrief', () => {
  it('lists the lessons, says where knowledge goes, and how to treat lessons about hopp', () => {
    const b = triageLessonsBrief('site');
    expect(b).toContain(projectLessonsCommand('site'));
    expect(b).toContain('`hopp lessons close <id>`');
    expect(b).toContain('`hopp lessons label <id> hopp.about=hopp`');
    expect(b).toContain('list what you did with each lesson');
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

describe('a launch carries the open lessons of its own project', () => {
  it('newest first, open ones only, never another project\'s or one about hopp', async () => {
    d.lessons = [
      projectLesson(1, 'site', 'old site fact'),
      projectLesson(2, 'shop', 'a shop fact'),
      projectLesson(3, 'site', 'closed site fact', { status: 'closed' }),
      makeLesson(4, { body: 'hopp send lost my text', labels: { 'hopp.project': 'site', 'hopp.about': 'hopp' } }),
      makeLesson(5, { body: 'unsorted', labels: { 'hopp.project': 'site' } }),
      projectLesson(6, 'site', 'new site fact'),
    ];
    for (const t of Object.values(await launch())) {
      expect(t).toContain('- #6 new site fact\n- #1 old site fact');
      for (const no of ['a shop fact', 'closed site fact', 'hopp send lost', 'unsorted']) expect(t).not.toContain(no);
    }
  });

  it('a lesson closed since the last launch is gone from the next one', async () => {
    d.lessons = [projectLesson(1, 'site', 'soon obsolete')];
    expect((await launch()).orch).toContain('#1 soon obsolete');
    await svc.closeLesson(1);
    expect((await launch()).orch).not.toContain('Lessons from earlier tasks');
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
