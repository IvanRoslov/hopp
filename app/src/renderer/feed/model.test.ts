import { describe, expect, it } from 'vitest';
import { art, ask, feedTask, post } from '../../../test/feedBridge';
import { answerLine, artifactKind, author, feedEntries, findArtifact, latestByName, parseRef, stageTag, submittedRefs } from './model';

describe('feed model', () => {
  const t = feedTask();
  it('puts the brief first, then posts and asks by time, and filters by stage', () => {
    const p1 = post('late', { 'hopp.stage': 'script' }, { created_at: 300 });
    const a1 = ask('q', { 'hopp.stage': 'scenes' }, { created_at: 250 });
    const e = feedEntries(t, { posts: [p1], asks: [a1], artifacts: [] }, '');
    expect(e.map((x) => x.kind)).toEqual(['brief', 'ask', 'post']);
    expect(feedEntries(t, { posts: [p1], asks: [a1], artifacts: [] }, 'script').map((x) => x.key)).toEqual(['p' + p1.id]);
  });
  it('names authors and stage tags', () => {
    expect([author('', t), author('promo', t), author('promo-w1', t)]).toEqual(['You', 'Orchestrator', 'promo-w1']);
    expect(stageTag(post('x', { 'hopp.stage': 'scenes', 'hopp.substage': 's2', 'hopp.substage_title': 'Scene 2' }), t.pipeline)).toBe('Scenes · Scene 2');
    expect(stageTag(post('x', { 'hopp.stage': 'scenes', 'hopp.substage': 's2' }), t.pipeline)).toBe('Scenes · s2');
    expect(stageTag(post('x', { 'hopp.stage': 'ghost' }), t.pipeline)).toBe('');
  });
  it('reads artifact references and kinds', () => {
    expect(parseRef('scene-2@3')).toEqual({ name: 'scene-2', version: 3 });
    expect(parseRef('/tmp/x.png')).toBeNull();
    const a = art('scene', 2);
    expect(findArtifact([a], 'scene@2')).toBe(a);
    expect(findArtifact([a], 'scene@3')).toBeNull();
    expect(artifactKind({ mime: 'video/mp4', filename: 'a' })).toBe('video');
    expect(artifactKind({ mime: '', filename: 'page.html' })).toBe('html');
    expect(artifactKind({ mime: 'text/markdown', filename: 'a.md' })).toBe('text');
    expect(artifactKind({ mime: 'application/zip', filename: 'a.zip' })).toBe('file');
  });
  it('latest version per name, submitted refs and answer lines', () => {
    const v1 = art('a', 1, { created_at: 1 });
    const v2 = art('a', 2, { created_at: 2 });
    const b = art('b', 1, { created_at: 3 });
    expect(latestByName([v1, v2, b]).map((x) => `${x.name}@${x.version}`)).toEqual(['b@1', 'a@2']);
    const open = ask('s', { 'hopp.kind': 'submission' }, { attachments: ['a@2'] });
    const closed = ask('s', { 'hopp.kind': 'submission' }, { attachments: ['b@1'], status: 'answered' });
    expect([...submittedRefs([open, closed])]).toEqual(['a@2']);
    expect(answerLine({ ...open, status: 'answered', choice: 'Return', answer: 'Fix it' })).toBe('You answered: Return — Fix it');
    expect(answerLine({ ...open, status: 'withdrawn' })).toBe('withdrawn');
  });
});
