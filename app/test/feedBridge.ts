// A small fake bridge for the feed, stages and artifacts components: an
// in-memory task feed and recorders for every call those components make.
import { vi } from 'vitest';
import type { HoppBridge } from '../src/shared/bridge';
import type { Artifact, Pipeline, Post, Result, SubmissionAnswer, Task, TaskFeed } from '../src/shared/shell';
import type { AttachmentInfo, PasteResult } from '../src/shared/attachments';
import type { Ask } from '../src/shared/types';

export const PIPELINE: Pipeline = {
  id: 'video', name: 'Promo video', createdAt: 1, updatedAt: 1,
  stages: [
    { id: 'script', name: 'Script', does: 'Write the script.', result: 'A script.', substages: false, approval: true },
    { id: 'scenes', name: 'Scenes', does: 'Make each scene.', result: 'Scenes.', substages: true, approval: true },
    { id: 'assembly', name: 'Assembly', does: 'Cut it together.', result: 'The video.', substages: false, approval: true },
  ],
};

export function feedTask(over: Partial<Task> = {}): Task {
  return {
    id: 'promo', projectSlug: 'site', title: 'Promo video', brief: 'Make a promo video from the brief.', sessionId: 'promo', dir: '/w/promo',
    branch: null, orchestratorProfile: 'p', workerProfiles: ['p'], addedWorkerProfiles: [], pipeline: PIPELINE, base: null, startedBy: null, status: 'active', hidden: false, createdAt: 100, finishedAt: 0, ...over,
  };
}

let ids = 1000;
export const post = (body: string, labels: Record<string, string> = {}, over: Partial<Post> = {}): Post => ({
  id: ++ids, from: 'promo', labels: { 'hopp.task': 'promo', ...labels }, body, attachments: [], created_at: 200 + ids, ...over,
});
export const ask = (body: string, labels: Record<string, string> = {}, over: Partial<Ask> = {}): Ask => ({
  id: ++ids, from: 'promo', labels: { 'hopp.task': 'promo', ...labels }, body, options: [], attachments: [], status: 'open', created_at: 200 + ids, ...over,
});
export const art = (name: string, version: number, over: Partial<Artifact> = {}): Artifact => ({
  id: ++ids, scope: 'promo', name, version, filename: name + '.png', mime: 'image/png', size: 2048, sha256: '', from: 'promo',
  labels: { 'hopp.task': 'promo' }, created_at: 200 + ids, ...over,
});

export function feedBridge(feed: TaskFeed) {
  let listeners: ((id: string) => void)[] = [];
  const calls = {
    taskFeed: vi.fn(async (_id: string) => structuredClone(state.feed)),
    postToTask: vi.fn(async (_id: string, text: string, stage?: string): Promise<Result<Post>> => {
      if (state.postFails) return { ok: false, error: { code: 'orchestrator_not_running', message: state.postFails } };
      const p = post(text, stage ? { 'hopp.stage': stage } : {}, { from: '' });
      state.feed.posts.push(p);
      return { ok: true, value: p };
    }),
    answerSubmission: vi.fn(async (id: number, a: SubmissionAnswer): Promise<Result<Ask>> => {
      const x = state.feed.asks.find((k) => k.id === id)!;
      x.status = 'answered';
      x.choice = a.choice;
      if (a.text) x.answer = a.text;
      return { ok: true, value: x };
    }),
    answerAsk: vi.fn(async (id: number, body: { choice?: string; answer?: string }) => {
      const x = state.feed.asks.find((k) => k.id === id)!;
      Object.assign(x, { status: 'answered', ...body });
      return x;
    }),
    dismissAsk: vi.fn(async (id: number) => {
      const x = state.feed.asks.find((k) => k.id === id)!;
      Object.assign(x, { status: 'withdrawn', reason: 'dismissed' });
      return x;
    }),
    artifactText: vi.fn(async (id: number): Promise<Result<string>> => ({ ok: true, value: `text of ${id}` })),
    // Attachments: state.paths is what exists; state.picks is what each
    // open dialog returns.
    pickAttachments: vi.fn(async () => describe(state.picks.shift() ?? [])),
    pasteAttachments: vi.fn(async (): Promise<PasteResult> => ({ kind: 'none', items: [] })),
    describePaths: vi.fn(async (list: string[]) => describe(list)),
    openAttachment: vi.fn(async (_path: string, _reveal: boolean) => ''),
  };
  const describe = (list: string[]): AttachmentInfo[] =>
    list.map((p) => (state.paths[p] ? { path: p, dir: state.paths[p] === 'dir' } : { path: p, dir: false, missing: true }));
  const state = { feed: structuredClone(feed), postFails: '' as string, paths: {} as Record<string, 'file' | 'dir'>, picks: [] as string[][] };
  const bridge = {
    daemon: { answerAsk: calls.answerAsk, dismissAsk: calls.dismissAsk },
    terminal: {},
    shell: {
      taskFeed: calls.taskFeed,
      onFeedChanged: (cb: (id: string) => void) => {
        listeners.push(cb);
        return () => (listeners = listeners.filter((l) => l !== cb));
      },
      postToTask: calls.postToTask,
      answerSubmission: calls.answerSubmission,
      artifactUrl: (id: number) => `hopp-artifact://${id}`,
      artifactText: calls.artifactText,
      pickAttachments: calls.pickAttachments,
      pasteAttachments: calls.pasteAttachments,
      describePaths: calls.describePaths,
      openAttachment: calls.openAttachment,
      pathForFile: (f: File) => '/dropped/' + f.name,
    },
  } as unknown as HoppBridge;
  return { bridge, calls, state, emit: (id: string) => listeners.forEach((l) => l(id)) };
}
