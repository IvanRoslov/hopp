import { describe, expect, it } from 'vitest';
import { makeAsk, makeSession } from '../../../test/fakeDaemon';
import { makeAgent, makeProject, makeTask } from '../../../test/bridge';
import type { Waiting } from '../../shared/types';
import { agentStatus, ownerOf, recentTasks, sessionWord, taskSessions, taskStatus, waitingRows, workGroups } from './shellModel';

const q = (text: string) => ({ asked_at: 1, questions: [{ question: text, header: '', multi_select: false, options: [{ label: 'Yes' }] }] });

describe('taskSessions', () => {
  it('lists the orchestrator first, then its descendants by age', () => {
    const t = makeTask('t1', 'p', { sessionId: 'orc' });
    const s = [
      makeSession('w2', { parent: 'orc', created_at: 5 }),
      makeSession('orc', { created_at: 1 }),
      makeSession('w1', { parent: 'orc', created_at: 3 }),
      makeSession('w1a', { parent: 'w1', created_at: 4 }),
      makeSession('other', { created_at: 2 }),
    ];
    expect(taskSessions(t, s).map((x) => x.id)).toEqual(['orc', 'w1', 'w1a', 'w2']);
  });
});

describe('taskStatus', () => {
  const t = makeTask('t1', 'p', { sessionId: 'orc' });
  const st = (sess: Parameters<typeof makeSession>[1], waiting = 0, task = t) =>
    taskStatus(task, [makeSession('orc', sess)], waiting);
  it('maps the orchestrator session to a word', () => {
    expect(st({ state: 'spawning' })).toMatchObject({ kind: 'starting', word: 'starting' });
    expect(st({ activity: 'active' })).toMatchObject({ kind: 'working' });
    expect(st({ activity: 'ready' })).toMatchObject({ kind: 'idle' });
    expect(st({ activity: 'ready' }, 2)).toMatchObject({ kind: 'waiting', word: 'waiting for me' });
    expect(st({ activity: 'exited' })).toMatchObject({ kind: 'exited', word: 'agent exited' });
    expect(st({ state: 'killed' })).toMatchObject({ kind: 'stopped', word: 'stopped' });
    expect(st({ state: 'done' })).toMatchObject({ kind: 'stopped' });
    expect(st({ state: 'errored' })).toMatchObject({ kind: 'error', word: 'error' });
    expect(st({}, 0, { ...t, status: 'finished' })).toMatchObject({ kind: 'finished', word: 'finished' });
  });
  it('a task without a daemon session is starting at first, then gone', () => {
    const created = { ...t, createdAt: 1_800_000_000_000 };
    expect(taskStatus(created, [], 0, 1_800_000_060_000)).toMatchObject({ kind: 'starting' });
    expect(taskStatus(created, [], 0, 1_800_000_500_000)).toMatchObject({ kind: 'gone', word: 'session gone' });
    // Times in seconds read the same way.
    expect(taskStatus({ ...t, createdAt: 1_800_000_000 }, [], 0, 1_800_000_060_000)).toMatchObject({ kind: 'starting' });
  });
});

describe('sessionWord', () => {
  it('names the state in words for the picker', () => {
    expect(sessionWord(makeSession('a', { activity: 'active' }))).toBe('working');
    expect(sessionWord(makeSession('a', { activity: 'waiting_input' }))).toBe('waiting for input');
    expect(sessionWord(makeSession('a', { state: 'killed' }))).toBe('stopped');
    expect(sessionWord(makeSession('a', { state: 'done' }))).toBe('exited');
    expect(sessionWord(makeSession('a', { activity: 'exited' }))).toBe('agent exited');
  });
});

describe('ownerOf and waitingRows', () => {
  const projects = [makeProject('hopp')];
  const tasks = [makeTask('fix-api', 'hopp', { title: 'Fix the API', sessionId: 'fix-api' })];
  const agents = [makeAgent('cto')];
  const sessions = [
    makeSession('fix-api'),
    makeSession('fix-api-w', { parent: 'fix-api', labels: { 'hopp.task': 'fix-api' } }),
    makeSession('deep', { parent: 'fix-api-w' }),
    makeSession('cto'),
    makeSession('stray'),
  ];
  const state = { projects, tasks, agents };

  it('finds the task through the label or the parent chain, and agents by name', () => {
    expect(ownerOf('fix-api', state, sessions)).toEqual({ kind: 'task', id: 'fix-api' });
    expect(ownerOf('fix-api-w', state, sessions)).toEqual({ kind: 'task', id: 'fix-api' });
    expect(ownerOf('deep', state, sessions)).toEqual({ kind: 'task', id: 'fix-api' });
    expect(ownerOf('cto', state, sessions)).toEqual({ kind: 'agent', name: 'cto' });
    expect(ownerOf('stray', state, sessions)).toBeNull();
  });

  it('makes one row per open question with its owner under it', () => {
    const w: Waiting = {
      asks: [makeAsk(7, 'fix-api', { body: 'Ready for review\nsee branch' }), makeAsk(8, 'cto', { body: 'Hire?' }), makeAsk(9, 'stray', { body: 'Who am I?' })],
      questions: [{ session: 'deep', question: q('Run the tests?') }],
    };
    const rows = waitingRows(w, state, sessions);
    expect(rows.map((r) => [r.text, r.under])).toEqual([
      ['Run the tests?', 'Fix the API'],
      ['Ready for review', 'Fix the API'],
      ['Hire?', 'cto'],
      ['Who am I?', 'stray'],
    ]);
    expect(rows[0]).toMatchObject({ owner: { kind: 'task', id: 'fix-api' }, session: 'deep' });
  });

  it('a permission dialog without a question text gets a readable line', () => {
    const w: Waiting = { asks: [], questions: [{ session: 'cto', question: { asked_at: 1, source: 'permission', raw: 'Allow edit?', questions: [] } }] };
    expect(waitingRows(w, state, sessions)[0]!.text).toBe('Permission: Allow edit?');
  });
});

describe('workGroups and recentTasks', () => {
  it('groups active visible tasks by project, only projects that have some', () => {
    const projects = [makeProject('a', { createdAt: 1 }), makeProject('b', { createdAt: 2 }), makeProject('c', { createdAt: 3 })];
    const tasks = [
      makeTask('t1', 'b', { createdAt: 5 }),
      makeTask('t2', 'a', { createdAt: 6 }),
      makeTask('t3', 'a', { createdAt: 4 }),
      makeTask('t4', 'c', { status: 'finished', finishedAt: 10 }),
      makeTask('t5', 'a', { hidden: true }),
      makeTask('t6', 'c', { status: 'finished', finishedAt: 20 }),
    ];
    const g = workGroups({ projects, tasks, agents: [] });
    expect(g.map((x) => [x.project.slug, x.tasks.map((t) => t.id)])).toEqual([
      ['a', ['t3', 't2']],
      ['b', ['t1']],
    ]);
    expect(recentTasks({ projects, tasks, agents: [] }).map((t) => t.id)).toEqual(['t6', 't4']);
  });
});

describe('agentStatus', () => {
  it('is off without a live session, else the session state', () => {
    expect(agentStatus(makeAgent('cto'), [])).toMatchObject({ kind: 'off' });
    expect(agentStatus(makeAgent('cto'), [makeSession('cto', { state: 'killed' })])).toMatchObject({ kind: 'off' });
    expect(agentStatus(makeAgent('cto'), [makeSession('cto', { activity: 'active' })])).toMatchObject({ kind: 'working' });
    expect(agentStatus(makeAgent('cto'), [makeSession('cto', { state: 'spawning' })])).toMatchObject({ kind: 'starting' });
  });
});
