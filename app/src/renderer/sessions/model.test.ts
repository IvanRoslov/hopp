import { describe, expect, it } from 'vitest';
import { makeSession } from '../../../test/fakeDaemon';
import { buildTree, isEnded, stateWord } from './model';

describe('stateWord', () => {
  it.each([
    [{ state: 'spawning', activity: '' }, 'starting'],
    [{ state: 'running', activity: 'active' }, 'working'],
    [{ state: 'running', activity: 'ready' }, 'idle'],
    [{ state: 'running', activity: 'idle' }, 'idle'],
    [{ state: 'running', activity: '' }, 'idle'],
    [{ state: 'running', activity: 'waiting_input' }, 'waiting for input'],
    [{ state: 'running', activity: 'blocked' }, 'waiting for input'],
    [{ state: 'running', activity: 'exited' }, 'exited'],
    [{ state: 'done', activity: '' }, 'exited'],
    [{ state: 'killed', activity: 'active' }, 'exited'],
    [{ state: 'errored', activity: '' }, 'errored'],
  ])('%o → %s', (s, word) => {
    expect(stateWord(makeSession('x', s))).toBe(word);
  });

  it('a pending question means waiting for input', () => {
    expect(stateWord(makeSession('x', { activity: 'active', question: { questions: [], asked_at: 1 } }))).toBe('waiting for input');
  });

  it('ended means the session is no longer live', () => {
    expect(isEnded(makeSession('x', { state: 'running' }))).toBe(false);
    expect(isEnded(makeSession('x', { state: 'spawning' }))).toBe(false);
    expect(isEnded(makeSession('x', { state: 'done' }))).toBe(true);
    expect(isEnded(makeSession('x', { state: 'errored' }))).toBe(true);
  });
});

describe('buildTree', () => {
  const list = [
    makeSession('b', { created_at: 2 }),
    makeSession('a', { created_at: 1 }),
    makeSession('a1', { parent: 'a', created_at: 3 }),
    makeSession('a1x', { parent: 'a1', created_at: 4 }),
    makeSession('old', { state: 'done', created_at: 5 }),
    makeSession('a2', { parent: 'a', state: 'killed', created_at: 6 }),
    makeSession('orphan', { parent: 'gone', created_at: 7 }),
  ];
  const flat = (nodes: ReturnType<typeof buildTree>, depth = 0): string[] =>
    nodes.flatMap((n) => [`${depth}:${n.session.id}`, ...flat(n.children, depth + 1)]);

  it('nests children under parents, hides ended sessions', () => {
    expect(flat(buildTree(list, false))).toEqual(['0:a', '1:a1', '2:a1x', '0:b', '0:orphan']);
  });

  it('shows ended sessions when asked', () => {
    expect(flat(buildTree(list, true))).toEqual(['0:a', '1:a1', '2:a1x', '1:a2', '0:b', '0:old', '0:orphan']);
  });

  it('a live child of an ended parent stays visible at the top', () => {
    const l = [makeSession('p', { state: 'done' }), makeSession('c', { parent: 'p' })];
    expect(flat(buildTree(l, false))).toEqual(['0:c']);
    expect(flat(buildTree(l, true))).toEqual(['0:p', '1:c']);
  });
});
