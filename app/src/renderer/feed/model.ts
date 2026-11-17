// The feed's pure model: what entries a task's feed shows, in what order,
// with which author and stage tag. No React here.
import { KIND_PAID, KIND_SUBMISSION, LABEL, type Artifact, type Pipeline, type Post, type StageState, type Task, type TaskFeed } from '../../shared/shell';
import type { Ask } from '../../shared/types';

export type Entry =
  | { kind: 'brief'; key: string; ts: number; body: string }
  | { kind: 'post'; key: string; ts: number; post: Post }
  | { kind: 'ask'; key: string; ts: number; ask: Ask };

const labelsOf = (x: { labels: Record<string, string> | null }) => x.labels ?? {};

export function askKind(a: Ask): 'submission' | 'paid' | 'question' {
  const k = labelsOf(a)[LABEL.kind];
  if (k === KIND_SUBMISSION) return 'submission';
  if (k === KIND_PAID) return 'paid';
  return 'question';
}

export function stageOf(x: { labels: Record<string, string> | null }): string {
  return labelsOf(x)[LABEL.stage] ?? '';
}

// entries: the human's request first, then posts and asks by time.
export function feedEntries(task: Task, feed: TaskFeed, stageFilter: string): Entry[] {
  const out: Entry[] = [];
  if (!stageFilter) out.push({ kind: 'brief', key: 'brief', ts: task.createdAt, body: task.brief });
  for (const p of feed.posts) {
    if (stageFilter && stageOf(p) !== stageFilter) continue;
    out.push({ kind: 'post', key: 'p' + p.id, ts: p.created_at, post: p });
  }
  for (const a of feed.asks) {
    if (stageFilter && stageOf(a) !== stageFilter) continue;
    out.push({ kind: 'ask', key: 'a' + a.id, ts: a.created_at, ask: a });
  }
  const rank = (e: Entry) => (e.kind === 'brief' ? 0 : 1);
  return out.sort((x, y) => rank(x) - rank(y) || x.ts - y.ts || x.key.localeCompare(y.key));
}

export function author(from: string, task: Task): string {
  if (!from) return 'You';
  if (from === task.sessionId) return 'Orchestrator';
  return from;
}

// stageTag: "Stage" or "Stage · Substage" for the labels of an item. The
// substage's title is the one the stage's substages know (the first title
// seen for that slug), since an agent may label only one post with it.
export function stageTag(x: { labels: Record<string, string> | null }, pipeline: Pipeline | null, stages: StageState[] = []): string {
  const l = labelsOf(x);
  const st = pipeline?.stages.find((s) => s.id === l[LABEL.stage]);
  if (!st) return '';
  const slug = l[LABEL.substage];
  const known = slug ? stages.find((s) => s.stageId === st.id)?.substages.find((s) => s.slug === slug)?.title : undefined;
  const sub = slug ? (known && known !== slug ? known : l[LABEL.substageTitle] || known || slug) : '';
  return sub ? `${st.name} · ${sub}` : st.name;
}

export function clock(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + hm;
}

// parseRef: "name@version" → its parts; null for anything else (a path, a URL).
export function parseRef(ref: string): { name: string; version: number } | null {
  const m = /^([a-z0-9][a-z0-9._-]*)@(\d+)$/.exec(ref.trim());
  return m ? { name: m[1]!, version: Number(m[2]) } : null;
}

export function findArtifact(artifacts: Artifact[], ref: string): Artifact | null {
  const r = parseRef(ref);
  if (!r) return null;
  return artifacts.find((a) => a.name === r.name && a.version === r.version) ?? null;
}

export type ArtifactKind = 'image' | 'video' | 'html' | 'text' | 'file';

export function artifactKind(a: Pick<Artifact, 'mime' | 'filename'>): ArtifactKind {
  const m = a.mime.toLowerCase();
  const f = a.filename.toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif)$/.test(f)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(f)) return 'video';
  if (m === 'text/html' || /\.html?$/.test(f)) return 'html';
  if (m.startsWith('text/') || /json|xml|yaml|javascript|markdown/.test(m) || /\.(md|markdown|txt|json|ya?ml|csv|ts|js|css|py|go|sh)$/.test(f)) return 'text';
  return 'file';
}

// isMarkdown: a markdown artifact, by its type or its file name.
export function isMarkdown(a: Pick<Artifact, 'mime' | 'filename'>): boolean {
  return a.mime.toLowerCase().split(';')[0]!.trim() === 'text/markdown' || /\.(md|markdown)$/i.test(a.filename);
}

// resolveArtifactRef: the artifact a markdown link or image names, relative
// to the others: `name@version`, `name` (its latest version), or a file name
// (`./chart.png`, its latest version). null when it names none.
export function resolveArtifactRef(artifacts: Artifact[], ref: string): Artifact | null {
  let r = ref.trim().replace(/^\.\//, '').split(/[?#]/)[0]!;
  try {
    r = decodeURIComponent(r);
  } catch {
    // Keep it as written.
  }
  if (!r || r.includes('/')) return null;
  const at = /^(.+)@(\d+)$/.exec(r);
  if (at) return artifacts.find((a) => a.name === at[1] && a.version === Number(at[2])) ?? null;
  const latest = (pick: (a: Artifact) => boolean) =>
    artifacts.filter(pick).reduce<Artifact | null>((best, a) => (!best || a.version > best.version ? a : best), null);
  return latest((a) => a.name === r) ?? latest((a) => a.filename === r);
}

export const KIND_WORD: Record<ArtifactKind, string> = { image: 'Image', video: 'Video', html: 'HTML page', text: 'Text', file: 'File' };

// submittedRefs: the name@version list of every open submission.
export function submittedRefs(asks: Ask[]): Set<string> {
  const out = new Set<string>();
  for (const a of asks) if (a.status === 'open' && askKind(a) === 'submission') for (const r of a.attachments ?? []) out.add(r.trim());
  return out;
}

// latestByName: the newest version of each artifact name, newest first.
export function latestByName(artifacts: Artifact[]): Artifact[] {
  const m = new Map<string, Artifact>();
  for (const a of artifacts) if ((m.get(a.name)?.version ?? 0) < a.version) m.set(a.name, a);
  return [...m.values()].sort((x, y) => y.created_at - x.created_at || x.name.localeCompare(y.name));
}

// answerLine: the quiet line of an answered or withdrawn ask.
export function answerLine(a: Ask): string {
  if (a.status === 'withdrawn') return 'withdrawn';
  const parts = [a.choice, a.answer].filter((x): x is string => !!x && x.trim() !== '');
  return 'You answered: ' + (parts.length ? parts.join(' — ') : '…');
}
