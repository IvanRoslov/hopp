// What the page shows, derived from the shell store and the daemon's
// sessions. Pure functions: the store keeps only what the daemon cannot know.
import type { LongAgent, Project, ShellState, Task } from '../../shared/shell';
import type { Session, SessionQuestion, Waiting } from '../../shared/types';

const TASK_LABEL = 'hopp.task';
const isLive = (s: Session) => s.state === 'running' || s.state === 'spawning';
const byAge = (a: Session, b: Session) => a.created_at - b.created_at || a.id.localeCompare(b.id);

// taskSessions: the orchestrator, then every descendant (depth first, oldest
// first at each level).
export function taskSessions(task: Task, sessions: Session[]): Session[] {
  return sessionTree(task.sessionId, sessions);
}

// sessionTree: a session and every descendant of it.
export function sessionTree(rootId: string, sessions: Session[]): Session[] {
  const byParent = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.parent) continue;
    const l = byParent.get(s.parent) ?? [];
    l.push(s);
    byParent.set(s.parent, l);
  }
  const root = sessions.find((s) => s.id === rootId);
  if (!root) return [];
  const out: Session[] = [];
  const walk = (s: Session) => {
    out.push(s);
    for (const c of (byParent.get(s.id) ?? []).sort(byAge)) walk(c);
  };
  walk(root);
  return out;
}

export type StatusKind = 'starting' | 'working' | 'idle' | 'waiting' | 'exited' | 'stopped' | 'error' | 'finished' | 'gone' | 'off';
export interface Status {
  kind: StatusKind;
  word: string;
}

const WORDS: Record<StatusKind, string> = {
  starting: 'starting',
  working: 'working',
  idle: 'idle',
  waiting: 'waiting for me',
  exited: 'agent exited',
  stopped: 'stopped',
  error: 'error',
  finished: 'finished',
  gone: 'session gone',
  off: 'off',
};
const status = (kind: StatusKind): Status => ({ kind, word: WORDS[kind] });

// sessionStatus: one session's state, before any question is counted.
function sessionStatus(s: Session): Status {
  if (s.state === 'errored') return status('error');
  if (s.state === 'killed' || s.state === 'done') return status('stopped');
  if (s.state === 'spawning') return status('starting');
  if (s.activity === 'exited') return status('exited');
  if (s.activity === 'active') return status('working');
  return status('idle');
}

// A task the daemon has no session for yet counts as starting for this long
// after it was created.
export const STARTING_GRACE_MS = 120_000;

// toMs reads a store time that may be in seconds or milliseconds.
export const toMs = (t: number) => (t > 1e12 ? t : t * 1000);

// taskStatus: the task's state shown in the list and its header. `waiting`
// is the number of open questions anywhere in the task's session tree.
export function taskStatus(task: Task, sessions: Session[], waiting: number, now = Date.now()): Status {
  if (task.status === 'finished') return status('finished');
  const root = sessions.find((s) => s.id === task.sessionId);
  if (!root) return now - toMs(task.createdAt) < STARTING_GRACE_MS ? status('starting') : status('gone');
  const st = sessionStatus(root);
  if (waiting > 0 && (st.kind === 'working' || st.kind === 'idle')) return status('waiting');
  return st;
}

// sessionWord: the state of one session in words, for the session picker.
export function sessionWord(s: Session): string {
  const st = sessionStatus(s);
  if (st.kind === 'stopped') return s.state === 'done' ? 'exited' : 'stopped';
  if ((st.kind === 'working' || st.kind === 'idle') && (s.question || s.activity === 'waiting_input' || s.activity === 'blocked'))
    return 'waiting for input';
  return st.word;
}

export function agentStatus(agent: LongAgent, sessions: Session[]): Status {
  const s = sessions.find((x) => x.id === agent.name);
  if (!s || !isLive(s)) return status('off');
  const st = sessionStatus(s);
  if (st.kind === 'working' || st.kind === 'idle') {
    if (s.question || s.activity === 'waiting_input' || s.activity === 'blocked') return status('waiting');
  }
  return st;
}

export type Owner = { kind: 'task'; id: string } | { kind: 'agent'; name: string };

// ownerOf finds the task or long-lived agent a session belongs to: by the
// task label children inherit, else by walking up the parent chain.
export function ownerOf(sessionId: string, state: ShellState, sessions: Session[]): Owner | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const taskBySession = new Map(state.tasks.map((t) => [t.sessionId, t]));
  const agents = new Set(state.agents.map((a) => a.name));
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const t = taskBySession.get(id);
    if (t) return { kind: 'task', id: t.id };
    if (agents.has(id)) return { kind: 'agent', name: id };
    const s = byId.get(id);
    const label = s?.labels?.[TASK_LABEL];
    if (label && state.tasks.some((x) => x.id === label)) return { kind: 'task', id: label };
    id = s?.parent || undefined;
  }
  return null;
}

export interface WaitingRow {
  key: string;
  text: string;
  under: string;
  owner: Owner | null;
  session: string;
  // The ask this row stands for; absent for a screen question.
  askId?: number;
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? s.trim();

export function questionText(q: SessionQuestion): string {
  const text = q.questions.find((x) => x.question.trim())?.question;
  if (text) return firstLine(text);
  if (q.source === 'permission') return 'Permission: ' + firstLine(q.raw ?? 'the agent waits for approval');
  return q.raw ? firstLine(q.raw) : 'The agent waits on its screen';
}

// waitingRows: one row per open question, harness questions first, each with
// the task title or agent name under it.
export function waitingRows(w: Waiting, state: ShellState, sessions: Session[]): WaitingRow[] {
  const under = (session: string, owner: Owner | null) => {
    if (owner?.kind === 'task') return state.tasks.find((t) => t.id === owner.id)?.title ?? owner.id;
    if (owner?.kind === 'agent') return owner.name;
    return session;
  };
  const rows: WaitingRow[] = [];
  for (const q of w.questions) {
    const owner = ownerOf(q.session, state, sessions);
    rows.push({ key: 'q:' + q.session, text: questionText(q.question), under: under(q.session, owner), owner, session: q.session });
  }
  for (const a of w.asks) {
    const owner = a.from ? ownerOf(a.from, state, sessions) : null;
    rows.push({ key: 'a:' + a.id, text: firstLine(a.body), under: under(a.from || 'hopp', owner), owner, session: a.from, askId: a.id });
  }
  return rows;
}

// waitingCount: open questions per task id and per agent name.
export function waitingCount(w: Waiting | null, state: ShellState, sessions: Session[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!w) return out;
  for (const r of waitingRows(w, state, sessions)) {
    if (!r.owner) continue;
    const k = r.owner.kind === 'task' ? 'task:' + r.owner.id : 'agent:' + r.owner.name;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export interface WorkGroup {
  project: Project;
  tasks: Task[];
}

const visible = (t: Task) => !t.hidden;

export function workGroups(state: ShellState): WorkGroup[] {
  const projects = [...state.projects].sort((a, b) => a.createdAt - b.createdAt);
  return projects
    .map((project) => ({
      project,
      tasks: state.tasks
        .filter((t) => visible(t) && t.status === 'active' && t.projectSlug === project.slug)
        .sort((a, b) => a.createdAt - b.createdAt),
    }))
    .filter((g) => g.tasks.length > 0);
}

export function recentTasks(state: ShellState, limit = 10): Task[] {
  return state.tasks
    .filter((t) => visible(t) && t.status === 'finished')
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, limit);
}
