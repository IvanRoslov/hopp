import { describe, expect, it } from 'vitest';
import type { Pipeline, Post } from './shell';
import { deriveStages } from './stages';
import type { Ask } from './types';

const pipeline: Pipeline = {
  id: 'p', name: 'P', createdAt: 1, updatedAt: 1,
  stages: [
    { id: 'spec', name: 'Spec', does: '', result: '', substages: false, approval: true },
    { id: 'build', name: 'Build', does: '', result: '', substages: true, approval: false },
    { id: 'check', name: 'Check', does: '', result: '', substages: false, approval: true },
  ],
};

let n = 0;
const post = (ts: number, labels: Record<string, string>): Post => ({ id: ++n, from: 's', labels, body: 'b', attachments: [], created_at: ts });
const ask = (ts: number, labels: Record<string, string>, over: Partial<Ask> = {}): Ask => ({
  id: ++n, from: 's', labels, body: 'q', options: ['Accept', 'Return'], attachments: [], status: 'open', created_at: ts, ...over,
});
const started = (stage: string, ts: number, extra: Record<string, string> = {}) => post(ts, { 'hopp.stage': stage, 'hopp.event': 'stage_started', ...extra });
const submit = (stage: string, ts: number, over: Partial<Ask> = {}) => ask(ts, { 'hopp.stage': stage, 'hopp.kind': 'submission' }, over);
const status = (posts: Post[], asks: Ask[]) => deriveStages(pipeline, posts, asks).map((s) => s.status);

describe('deriveStages', () => {
  it('nothing yet: all not started', () => {
    expect(status([], [])).toEqual(['not_started', 'not_started', 'not_started']);
  });

  it('started, submitted, then accepted', () => {
    const p = [started('spec', 1)];
    const open = submit('spec', 2);
    expect(status(p, [open])).toEqual(['submitted', 'not_started', 'not_started']);
    const st = deriveStages(pipeline, p, [open])[0]!;
    expect(st.submission?.id).toBe(open.id);
    const done = { ...open, status: 'answered', choice: 'Accept', closed_at: 3 };
    expect(status(p, [done])).toEqual(['accepted', 'not_started', 'not_started']);
  });

  it('returned with the answer, then started again moves it on', () => {
    const p = [started('spec', 1)];
    const ret = submit('spec', 2, { status: 'answered', choice: 'Return', answer: 'Fix the title', closed_at: 3 });
    const s = deriveStages(pipeline, p, [ret])[0]!;
    expect(s.status).toBe('returned');
    expect(s.lastAnswer?.answer).toBe('Fix the title');
    expect(status([...p, started('spec', 4)], [ret])[0]).toBe('started');
    const again = submit('spec', 5);
    expect(status(p, [ret, again])[0]).toBe('submitted');
    expect(deriveStages(pipeline, p, [ret, again])[0]!.lastAnswer?.id).toBe(ret.id);
  });

  it('a withdrawn submission returns the stage to started', () => {
    expect(status([started('spec', 1)], [submit('spec', 2, { status: 'withdrawn', closed_at: 3 })])[0]).toBe('started');
  });

  it('a stage without approval is accepted when the next starts or it says done', () => {
    const base = [started('spec', 1)];
    const accepted = submit('spec', 2, { status: 'answered', choice: 'Accept', closed_at: 3 });
    expect(status([...base, started('build', 4)], [accepted])).toEqual(['accepted', 'started', 'not_started']);
    expect(status([...base, started('build', 4), started('check', 6)], [accepted])).toEqual(['accepted', 'accepted', 'started']);
    expect(status([...base, started('build', 4), post(5, { 'hopp.stage': 'build', 'hopp.event': 'stage_done' })], [accepted])[1]).toBe('accepted');
  });

  it('a stage that waits for approval is not passed by a later start', () => {
    expect(status([started('spec', 1), started('build', 2)], [])).toEqual(['started', 'started', 'not_started']);
  });

  it('collects substages in order with their titles, once each', () => {
    const p = [
      started('build', 1),
      started('build', 2, { 'hopp.substage': 'scene-1', 'hopp.substage_title': 'Scene 1' }),
      post(3, { 'hopp.stage': 'build', 'hopp.substage': 'scene-2' }),
      post(4, { 'hopp.stage': 'build', 'hopp.substage': 'scene-1', 'hopp.substage_title': 'Scene 1' }),
    ];
    expect(deriveStages(pipeline, p, [])[1]!.substages).toEqual([{ slug: 'scene-1', title: 'Scene 1' }, { slug: 'scene-2', title: 'scene-2' }]);
  });

  it('ignores items of unknown stages and other asks, and a plain ask starts its stage', () => {
    expect(status([post(1, { 'hopp.stage': 'ghost' })], [ask(2, {})])).toEqual(['not_started', 'not_started', 'not_started']);
    expect(status([], [ask(2, { 'hopp.stage': 'spec', 'hopp.kind': 'paid' })])[0]).toBe('started');
  });

  it('an older answered submission does not override a newer open one', () => {
    const old = submit('spec', 2, { status: 'answered', choice: 'Return', closed_at: 5 });
    const newer = submit('spec', 4);
    // closed after the newer was opened: still submitted
    expect(status([started('spec', 1)], [old, newer])[0]).toBe('submitted');
  });
});
