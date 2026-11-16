import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDaemon, makeAsk, makeSession } from '../../../test/fakeDaemon';
import { DaemonClient, DaemonError, DaemonUnavailable, resolveSocketPath } from './client';

let d: FakeDaemon;
let c: DaemonClient;

beforeEach(async () => {
  d = new FakeDaemon();
  await d.start();
  c = new DaemonClient(d.socketPath);
});
afterEach(async () => {
  await d.dispose();
});

describe('resolveSocketPath', () => {
  it('uses $HOPP_HOME, else ~/.hopp', () => {
    expect(resolveSocketPath({ HOPP_HOME: '/x/h' }, '/home/u')).toBe('/x/h/hopp.sock');
    expect(resolveSocketPath({}, '/home/u')).toBe('/home/u/.hopp/hopp.sock');
    expect(resolveSocketPath({ HOPP_HOME: '' }, '/home/u')).toBe('/home/u/.hopp/hopp.sock');
  });
});

describe('DaemonClient', () => {
  it('health', async () => {
    expect((await c.health()).status).toBe('ok');
  });

  it('lists live sessions, or all with all=true', async () => {
    d.sessions = [makeSession('a'), makeSession('b', { state: 'done' })];
    expect((await c.listSessions()).map((s) => s.id)).toEqual(['a']);
    expect((await c.listSessions({ all: true })).map((s) => s.id)).toEqual(['a', 'b']);
    expect(d.requests.at(-1)!.url).toBe('/v1/sessions?all=1');
  });

  it('gets one session with its children', async () => {
    d.sessions = [makeSession('p'), makeSession('k', { parent: 'p' })];
    const s = await c.getSession('p');
    expect(s.children).toEqual(['k']);
  });

  it('returns the attach command', async () => {
    d.sessions = [makeSession('a')];
    d.attach['a'] = ['tmux', 'attach', '-t', '=a'];
    expect(await c.attachCommand('a')).toEqual(['tmux', 'attach', '-t', '=a']);
  });

  it('lists asks with filters and answers one', async () => {
    d.asks = [makeAsk(1, 'a'), makeAsk(2, 'b'), makeAsk(3, 'a', { status: 'answered' })];
    expect((await c.listAsks({ from: 'a' })).map((x) => x.id)).toEqual([1]);
    expect((await c.listAsks({ from: 'a', status: 'all' })).map((x) => x.id)).toEqual([1, 3]);
    const a = await c.answerAsk(1, { choice: 'yes' });
    expect(a.status).toBe('answered');
    expect(JSON.parse(d.requests.at(-1)!.body)).toEqual({ choice: 'yes' });
  });

  it('answers a quiz', async () => {
    d.sessions = [makeSession('a', { question: { questions: [], asked_at: 1 } })];
    await c.answerQuiz('a', { answers: [{ question_index: 0, option_indices: [1] }] });
    const r = d.requests.at(-1)!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/v1/sessions/a/quiz/answer');
    expect(JSON.parse(r.body)).toEqual({ answers: [{ question_index: 0, option_indices: [1] }] });
  });

  it('reads waiting', async () => {
    d.sessions = [makeSession('a', { question: { questions: [], asked_at: 1 } })];
    d.asks = [makeAsk(1, 'a')];
    const w = await c.waiting();
    expect(w.asks).toHaveLength(1);
    expect(w.questions[0]!.session).toBe('a');
  });

  it('maps an error body to DaemonError', async () => {
    d.asks = [makeAsk(1, 'a', { status: 'answered' })];
    const err = await c.answerAsk(1, { choice: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err).toMatchObject({ status: 409, code: 'ask_closed', message: 'the ask is no longer open' });
  });

  it('maps a non-JSON error to DaemonError', async () => {
    d.override.set('GET /v1/health', { status: 502, body: 'nope' });
    const err = await c.health().catch((e) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect(err.status).toBe(502);
  });

  it('a stopped daemon or a missing socket is DaemonUnavailable', async () => {
    await d.stop();
    await expect(c.health()).rejects.toBeInstanceOf(DaemonUnavailable);
    const none = new DaemonClient('/nonexistent/dir/hopp.sock');
    await expect(none.listSessions()).rejects.toBeInstanceOf(DaemonUnavailable);
  });

  it('encodes ids in paths', async () => {
    d.sessions = [makeSession('a b')];
    await c.getSession('a b');
    expect(d.requests.at(-1)!.url).toBe('/v1/sessions/a%20b');
  });
});
