// A fake HoppBridge for renderer tests: an in-memory daemon plus hooks to
// push stream states and events, and (with `shell: true` or a seed) an
// in-memory shell layer that behaves like the main process's.
import { vi } from 'vitest';
import type { HoppBridge } from '../src/shared/bridge';
import type {
  Lesson,
  LongAgent,
  ModelProfile,
  Project,
  ProjectInput,
  Result,
  ShellBridge,
  ShellState,
  Task,
  ToolCatalog,
  ToolRules,
} from '../src/shared/shell';
import { SLUG_PATTERN, slugify } from '../src/shared/slug';
import type { Ask, DaemonEvent, Session, StreamState } from '../src/shared/types';
import { fakeTerminalBridge } from './renderer';

export function makeProject(slug: string, over: Partial<Project> = {}): Project {
  return {
    slug, name: slug, description: '', orchestratorRepo: null, workerRepos: [], guardrails: '', createdAt: 1, ...over,
  };
}

export function makeTask(id: string, projectSlug: string, over: Partial<Task> = {}): Task {
  return {
    id, projectSlug, title: id, brief: 'Do ' + id, sessionId: id, dir: '/tmp/work/' + id, branch: null,
    orchestratorProfile: 'claude-opus', workerProfiles: [], status: 'active', hidden: false, createdAt: 1, finishedAt: 0, ...over,
  };
}

export function makeAgent(name: string, over: Partial<LongAgent> = {}): LongAgent {
  return { name, profile: 'claude-opus', dir: '/tmp/agents/' + name, createdAt: 1, ...over };
}

export function makeProfile(name: string, over: Partial<ModelProfile> = {}): ModelProfile {
  return { name, agent: 'claude', model: name, effort: '', description: 'A profile', enabled: true, position: 0, ...over };
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: string, message: string, field?: string): Result<never> => ({
  ok: false,
  error: field ? { code, message, field } : { code, message },
});

export interface ShellSeed {
  state?: Partial<ShellState>;
  profiles?: ModelProfile[];
  tools?: ToolCatalog;
  rules?: ToolRules;
  lessons?: Lesson[];
  mail?: Record<string, number>;
  folders?: (string | null)[];
}

// fakeShell keeps a ShellState in memory and applies changes the way the main
// process does, so forms and lists can be tested end to end on the page.
export function fakeShell(seed: ShellSeed = {}, daemonSessions: () => Session[] = () => [], asks: () => Ask[] = () => []) {
  const st: ShellState = { projects: [], tasks: [], agents: [], ...seed.state };
  const cbs = new Set<(s: ShellState) => void>();
  const snapshot = (): ShellState => structuredClone(st);
  const changed = () => cbs.forEach((cb) => cb(snapshot()));
  const folders = [...(seed.folders ?? [])];
  let tools: ToolCatalog = seed.tools ?? { tools: [], broken: [] };
  let rules: ToolRules = seed.rules ?? { text: '', modifiedAt: 0 };
  let lessons: Lesson[] = seed.lessons ?? [];
  let clock = Date.now();

  const validateProject = (input: ProjectInput, current?: string): Result<string> => {
    if (!input.name.trim()) return fail('name_required', 'Give the project a name.', 'name');
    const slug = input.slug ?? slugify(input.name);
    if (!SLUG_PATTERN.test(slug)) return fail('slug_invalid', 'Use lowercase letters, digits and dashes.', 'slug');
    if (st.projects.some((p) => p.slug !== current && p.name === input.name)) return fail('name_taken', 'A project with this name exists.', 'name');
    if (st.projects.some((p) => p.slug !== current && p.slug === slug)) return fail('slug_taken', 'This slug is taken.', 'slug');
    if (input.orchestratorRepo === '/missing') return fail('folder_missing', 'This folder does not exist.', 'orchestratorRepo');
    return ok(slug);
  };

  const shell = {
    state: vi.fn(async () => snapshot()),
    onChanged: (cb: (s: ShellState) => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    createProject: vi.fn(async (input: ProjectInput) => {
      const v = validateProject(input);
      if (!v.ok) return v;
      const project: Project = {
        slug: v.value, name: input.name, description: input.description, orchestratorRepo: input.orchestratorRepo,
        workerRepos: input.workerRepos, guardrails: input.guardrails, createdAt: clock++,
      };
      st.projects.push(project);
      changed();
      return ok(project);
    }),
    updateProject: vi.fn(async (slug: string, input: ProjectInput) => {
      const i = st.projects.findIndex((p) => p.slug === slug);
      if (i < 0) return fail('project_not_found', 'No such project.');
      const v = validateProject({ ...input, slug: input.slug ?? slug }, slug);
      if (!v.ok) return v;
      const project: Project = {
        slug: v.value, name: input.name, description: input.description, orchestratorRepo: input.orchestratorRepo,
        workerRepos: input.workerRepos, guardrails: input.guardrails, createdAt: st.projects[i]!.createdAt,
      };
      st.projects[i] = project;
      changed();
      return ok(project);
    }),
    removeProject: vi.fn(async (slug: string) => {
      if (st.tasks.some((t) => t.projectSlug === slug && !t.hidden)) return fail('project_has_tasks', 'The project has tasks.');
      st.projects = st.projects.filter((p) => p.slug !== slug);
      changed();
      return ok(null);
    }),
    pickFolder: vi.fn(async () => (folders.length ? folders.shift()! : null)),
    listProfiles: vi.fn(async () => seed.profiles ?? [makeProfile('claude-opus'), makeProfile('codex', { agent: 'codex' })]),
    createTask: vi.fn(async (input: Parameters<ShellBridge['createTask']>[0]) => {
      if (!input.brief.trim()) return fail('brief_required', 'Say what needs to be done.', 'brief');
      const title = input.title || input.brief.split('\n')[0]!.slice(0, 60);
      const id = input.sessionName || slugify(title);
      if (st.tasks.some((t) => t.id === id) || daemonSessions().some((s) => s.id === id))
        return fail('session_taken', `A session named ${id} exists.`, 'sessionName');
      const task: Task = {
        id, projectSlug: input.projectSlug, title, brief: input.brief, sessionId: id, dir: '/tmp/work/' + id, branch: null,
        orchestratorProfile: input.orchestratorProfile, workerProfiles: input.workerProfiles, status: 'active', hidden: false,
        createdAt: clock++, finishedAt: 0,
      };
      st.tasks.push(task);
      changed();
      return ok(task);
    }),
    stopTask: vi.fn(async (_id: string) => ok(null)),
    resumeTask: vi.fn(async (_id: string) => ok(null)),
    finishTask: vi.fn(async (id: string) => {
      const t = st.tasks.find((x) => x.id === id)!;
      t.status = 'finished';
      t.finishedAt = clock++;
      changed();
      return ok(null);
    }),
    hideTask: vi.fn(async (id: string) => {
      st.tasks.find((x) => x.id === id)!.hidden = true;
      changed();
      return ok(null);
    }),
    createAgent: vi.fn(async (input: { name: string; profile: string; dir: string }) => {
      if (!SLUG_PATTERN.test(input.name)) return fail('name_invalid', 'Use lowercase letters, digits and dashes.', 'name');
      if (st.agents.some((a) => a.name === input.name)) return fail('name_taken', 'An agent with this name exists.', 'name');
      if (!input.dir) return fail('dir_required', 'Choose the agent’s folder.', 'dir');
      const a: LongAgent = { ...input, createdAt: clock++ };
      st.agents.push(a);
      changed();
      return ok(a);
    }),
    startAgent: vi.fn(async (_name: string) => ok(null)),
    stopAgent: vi.fn(async (_name: string) => ok(null)),
    removeAgent: vi.fn(async (name: string) => {
      st.agents = st.agents.filter((a) => a.name !== name);
      changed();
      return ok(null);
    }),
    agentMail: vi.fn(async () => seed.mail ?? {}),
    waiting: vi.fn(async () => {
      const list = daemonSessions();
      return {
        asks: asks().filter((a) => a.status === 'open'),
        questions: list.filter((s) => s.question && (s.state === 'running' || s.state === 'spawning')).map((s) => ({ session: s.id, question: s.question! })),
      };
    }),
    listTools: vi.fn(async () => tools),
    toolUsage: vi.fn(async (name: string) => `# ${name}\n\nUsage of ${name}.`),
    setToolEnabled: vi.fn(async (name: string, enabled: boolean) => {
      tools = { ...tools, tools: tools.tools.map((t) => (t.name === name ? { ...t, enabled } : t)) };
      return ok(null);
    }),
    toolRules: vi.fn(async () => rules),
    setToolRules: vi.fn(async (text: string) => {
      rules = { text, modifiedAt: 1_800_000_000 };
      return ok(rules);
    }),
    listLessons: vi.fn(async (status: 'new' | 'closed' | 'all') => lessons.filter((l) => status === 'all' || l.status === status)),
    closeLesson: vi.fn(async (id: number) => {
      lessons = lessons.map((l) => (l.id === id ? { ...l, status: 'closed' as const, closed_at: 2 } : l));
      return ok(null);
    }),
  } satisfies ShellBridge;

  return {
    shell,
    st,
    set(next: Partial<ShellState>) {
      Object.assign(st, next);
      changed();
    },
  };
}

export function fakeBridge(
  init: { sessions?: Session[]; asks?: Ask[]; state?: StreamState; shell?: ShellSeed | true } = {},
) {
  const stateCbs = new Set<(s: StreamState) => void>();
  const eventCbs = new Set<(e: DaemonEvent) => void>();
  const db = { sessions: init.sessions ?? [], asks: init.asks ?? [], state: init.state ?? ('open' as StreamState) };
  let eventId = 0;
  const daemon = {
    socketPath: vi.fn(async () => '/tmp/fake/hopp.sock'),
    streamState: vi.fn(async () => db.state),
    onStreamState: (cb: (s: StreamState) => void) => {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    onEvent: (cb: (e: DaemonEvent) => void) => {
      eventCbs.add(cb);
      return () => eventCbs.delete(cb);
    },
    listSessions: vi.fn(async (opts?: { all?: boolean }) =>
      opts?.all ? [...db.sessions] : db.sessions.filter((s) => s.state === 'running' || s.state === 'spawning'),
    ),
    getSession: vi.fn(async (id: string) => db.sessions.find((s) => s.id === id) ?? null),
    startDaemon: vi.fn(async () => ({ ok: true, message: 'started' })),
    listAsks: vi.fn(async (opts: { from?: string; status?: string } = {}) =>
      db.asks.filter((a) => (!opts.from || a.from === opts.from) && (opts.status === 'all' || a.status === (opts.status ?? 'open'))),
    ),
    answerAsk: vi.fn(async (id: number, body: { choice?: string; answer?: string }) => {
      const a = db.asks.find((x) => x.id === id)!;
      a.status = 'answered';
      Object.assign(a, body);
      return a;
    }),
    answerQuiz: vi.fn(async (_id: string, _body: unknown) => ({ status: 'answering' })),
  };
  const terminal = fakeTerminalBridge();
  // Without a shell seed the shell layer behaves like the preload's
  // placeholder before the main process wires it: every call rejects.
  const fs = init.shell
    ? fakeShell(init.shell === true ? {} : init.shell, () => db.sessions, () => db.asks)
    : null;
  const shell = fs
    ? fs.shell
    : (new Proxy({}, { get: (_t, name) => () => Promise.reject(new Error(`shell.${String(name)} is not wired yet`)) }) as ShellBridge);
  const bridge: HoppBridge = { daemon, terminal, shell };
  return {
    bridge,
    daemon,
    terminal,
    db,
    shell: fs?.shell,
    shellState: fs?.st,
    setShell: fs?.set,
    setState(s: StreamState) {
      db.state = s;
      stateCbs.forEach((cb) => cb(s));
    },
    emit(type: string, sessionId?: string, data: Record<string, unknown> = {}) {
      const e: DaemonEvent = { id: ++eventId, ts: 1, type, data };
      if (sessionId) e.session_id = sessionId;
      eventCbs.forEach((cb) => cb(e));
    },
  };
}
