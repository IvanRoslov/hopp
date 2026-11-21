// A fake HoppBridge for renderer tests: an in-memory daemon plus hooks to
// push stream states and events, and (with `shell: true` or a seed) an
// in-memory shell layer that behaves like the main process's.
import { copyProfileName, newProfileName } from '../src/shared/profileNames';
import { vi } from 'vitest';
import type { HoppBridge } from '../src/shared/bridge';
import type { AttachmentInfo, PasteResult } from '../src/shared/attachments';
import type {
  CopyProfileInput,
  NewProfileInput,
  HarnessCatalog,
  ImportResult,
  ProfileUpdate,
  Lesson,
  Pipeline,
  PipelineInput,
  Post,
  SubmissionAnswer,
  TaskFeed,
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
import { HARNESS_EFFORTS } from '../src/shared/shell';
import { SLUG_PATTERN, slugify } from '../src/shared/slug';
import { managedRepoFolder } from '../src/shared/repos';
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
    orchestratorProfile: 'claude-opus', workerProfiles: [], addedWorkerProfiles: [], pipeline: null, base: null, startedBy: null, status: 'active', hidden: false, createdAt: 1, finishedAt: 0, ...over,
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
  // Names a live tmux session outside hopp holds: create, rename and start refuse them.
  foreignTmux?: string[];
  folders?: (string | null)[];
  feeds?: Record<string, TaskFeed>;
  artifactTexts?: Record<number, string>;
  // Model profiles: what the catalog offers, what an import adds, which
  // profiles a running session or task uses.
  catalog?: HarnessCatalog[];
  importResult?: ImportResult;
  profilesInUse?: string[];
  // GitHub through gh: the status, the repositories, and what a clone does.
  github?: {
    status?: Partial<import('../src/shared/shell').GithubStatus>;
    repos?: import('../src/shared/shell').GithubRepo[];
    // Answers addGithubRepo; default: a managed clone under <home>/repos.
    add?: (fullName: string) => Promise<Result<{ path: string }>>;
  };
  // Attachments: the paths that exist ('dir' for a folder), what each open
  // dialog returns, and what each paste does.
  paths?: Record<string, 'file' | 'dir'>;
  picks?: string[][];
  pastes?: PasteResult[];
}

// fakeShell keeps a ShellState in memory and applies changes the way the main
// process does, so forms and lists can be tested end to end on the page.
export function fakeShell(seed: ShellSeed = {}, daemonSessions: () => Session[] = () => [], asks: () => Ask[] = () => []) {
  const st: ShellState = { projects: [], tasks: [], agents: [], pipelines: [], ...seed.state };
  const cbs = new Set<(s: ShellState) => void>();
  const snapshot = (): ShellState => structuredClone(st);
  const changed = () => cbs.forEach((cb) => cb(snapshot()));
  const folders = [...(seed.folders ?? [])];
  const paths: Record<string, 'file' | 'dir'> = { ...seed.paths };
  const picks = [...(seed.picks ?? [])];
  const pastes = [...(seed.pastes ?? [])];
  const describe = (list: string[]): AttachmentInfo[] =>
    list.map((p) => (paths[p] ? { path: p, dir: paths[p] === 'dir' } : { path: p, dir: false, missing: true }));
  let tools: ToolCatalog = seed.tools ?? { tools: [], broken: [] };
  let rules: ToolRules = seed.rules ?? { text: '', modifiedAt: 0 };
  let lessons: Lesson[] = seed.lessons ?? [];
  let profiles: ModelProfile[] = structuredClone(
    seed.profiles ?? [makeProfile('claude-opus', { isDefault: true }), makeProfile('codex', { agent: 'codex', position: 1 })],
  );
  const profileCbs = new Set<() => void>();
  const profilesChanged = () => profileCbs.forEach((cb) => cb());
  const ghStatus: import('../src/shared/shell').GithubStatus = {
    available: false, login: '', reason: 'gh is not set up in this test.', command: 'gh auth login', home: '/h', ...seed.github?.status,
  };
  const ghRepos = seed.github?.repos ?? [];
  // The main process stores times in Unix seconds.
  let clock = Math.floor(Date.now() / 1000);

  const validateProject = (input: ProjectInput, current?: string): Result<string> => {
    if (!input.name.trim()) return fail('name_required', 'Give the project a name.', 'name');
    const slug = input.slug ?? slugify(input.name);
    if (!SLUG_PATTERN.test(slug)) return fail('slug_invalid', 'Use lowercase letters, digits and dashes.', 'slug');
    if (st.projects.some((p) => p.slug !== current && p.name === input.name)) return fail('name_taken', 'A project with this name exists.', 'name');
    if (st.projects.some((p) => p.slug !== current && p.slug === slug)) return fail('slug_taken', 'This slug is taken.', 'slug');
    if (input.orchestratorRepo === '/missing') return fail('folder_missing', 'This folder does not exist.', 'orchestratorRepo');
    if (input.workerRepos.includes('/missing')) return fail('folder_missing', 'This folder does not exist: /missing.', 'workerRepos');
    return ok(slug);
  };

  const feeds: Record<string, TaskFeed> = structuredClone(seed.feeds ?? {});
  const feedCbs = new Set<(taskId: string) => void>();
  const feedChanged = (taskId: string) => feedCbs.forEach((cb) => cb(taskId));
  const feedOf = (taskId: string) => (feeds[taskId] ??= { posts: [], asks: [], artifacts: [] });
  let postId = 1000;
  let stageId = 1;

  const validatePipeline = (input: PipelineInput, current?: string): Result<null> => {
    if (!input.name.trim()) return fail('name_required', 'Name the pipeline.', 'name');
    if (st.pipelines.some((p) => p.id !== current && p.name === input.name.trim())) return fail('name_taken', 'A pipeline with this name exists.', 'name');
    if (input.stages.length === 0) return fail('stages_required', 'Add at least one stage.', 'stages');
    const empty = input.stages.findIndex((x) => !x.name.trim());
    if (empty >= 0) return fail('stage_name_required', 'Name every stage.', `stages.${empty}.name`);
    return ok(null);
  };
  const toPipeline = (input: PipelineInput, id: string, createdAt: number): Pipeline => ({
    id,
    name: input.name.trim(),
    stages: input.stages.map((x) => ({ ...x, id: x.id ?? 'st' + stageId++, name: x.name.trim() })),
    createdAt,
    updatedAt: clock++,
  });

  const shell = {
    state: vi.fn(async () => snapshot()),
    createPipeline: vi.fn(async (input: PipelineInput) => {
      const v = validatePipeline(input);
      if (!v.ok) return v;
      const p = toPipeline(input, 'pl' + clock, clock++);
      st.pipelines.push(p);
      changed();
      return ok(p);
    }),
    updatePipeline: vi.fn(async (id: string, input: PipelineInput) => {
      const i = st.pipelines.findIndex((p) => p.id === id);
      if (i < 0) return fail('pipeline_not_found', 'No such pipeline.');
      const v = validatePipeline(input, id);
      if (!v.ok) return v;
      const p = toPipeline(input, id, st.pipelines[i]!.createdAt);
      st.pipelines[i] = p;
      changed();
      return ok(p);
    }),
    removePipeline: vi.fn(async (id: string) => {
      st.pipelines = st.pipelines.filter((p) => p.id !== id);
      changed();
      return ok(null);
    }),
    taskFeed: vi.fn(async (taskId: string) => structuredClone(feedOf(taskId))),
    onFeedChanged: (cb: (taskId: string) => void) => {
      feedCbs.add(cb);
      return () => feedCbs.delete(cb);
    },
    postToTask: vi.fn(async (taskId: string, text: string, stage?: string) => {
      if (!text.trim()) return fail('text_required', 'Write something first.', 'text');
      const post: Post = { id: postId++, from: '', labels: stage ? { 'hopp.task': taskId, 'hopp.stage': stage } : { 'hopp.task': taskId }, body: text, attachments: [], created_at: Math.floor(Date.now() / 1000) };
      feedOf(taskId).posts.push(post);
      feedChanged(taskId);
      return ok(post);
    }),
    answerSubmission: vi.fn(async (askId: number, answer: SubmissionAnswer) => {
      for (const [taskId, f] of Object.entries(feeds)) {
        const a = f.asks.find((x) => x.id === askId);
        if (!a) continue;
        if (a.status !== 'open') return fail('ask_closed', 'This was already answered.');
        a.status = 'answered';
        a.choice = answer.choice;
        if (answer.choice === 'Return') a.answer = answer.text;
        a.closed_at = Math.floor(Date.now() / 1000);
        feedChanged(taskId);
        return ok(structuredClone(a));
      }
      return fail('ask_not_found', 'No such submission.');
    }),
    artifactUrl: (id: number) => 'hopp-artifact://v/' + id,
    artifactText: vi.fn(async (id: number) =>
      seed.artifactTexts && id in seed.artifactTexts ? ok(seed.artifactTexts[id]!) : fail('not_text', 'This artifact is not text.'),
    ),
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
    pickAttachments: vi.fn(async () => describe(picks.shift() ?? [])),
    pasteAttachments: vi.fn(async (): Promise<PasteResult> => pastes.shift() ?? { kind: 'none', items: [] }),
    describePaths: vi.fn(async (list: string[]) => describe(list)),
    openAttachment: vi.fn(async (_path: string, _reveal: boolean) => ''),
    pathForFile: vi.fn((file: File) => '/dropped/' + file.name),
    // Enabled first, each group in position order, as the main process does.
    listProfiles: vi.fn(async () =>
      structuredClone(profiles).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.position - b.position),
    ),
    createTask: vi.fn(async (input: Parameters<ShellBridge['createTask']>[0]) => {
      if (!input.brief.trim()) return fail('brief_required', 'Say what needs to be done.', 'brief');
      const title = input.title || input.brief.split('\n')[0]!.slice(0, 60);
      const id = input.sessionName || slugify(title);
      if (st.tasks.some((t) => t.id === id) || daemonSessions().some((s) => s.id === id))
        return fail('session_taken', `A session named ${id} exists.`, 'sessionName');
      const task: Task = {
        id, projectSlug: input.projectSlug, title, brief: input.brief, sessionId: id, dir: '/tmp/work/' + id, branch: null,
        orchestratorProfile: input.orchestratorProfile, workerProfiles: input.workerProfiles, addedWorkerProfiles: [],
        pipeline: input.pipelineId ? structuredClone(st.pipelines.find((p) => p.id === input.pipelineId) ?? null) : null,
        base: null, startedBy: null, status: 'active', hidden: false,
        createdAt: clock++, finishedAt: 0,
      };
      st.tasks.push(task);
      changed();
      return ok(task);
    }),
    stopTask: vi.fn(async (_id: string) => ok(null)),
    resumeTask: vi.fn(async (_id: string) => ok(null)),
    addTaskWorkers: vi.fn(async (id: string, profiles: string[]): Promise<Result<Task>> => {
      const t = st.tasks.find((x) => x.id === id);
      if (!t) return fail('task_not_found', `No task "${id}"`);
      for (const n of profiles) {
        if (!t.workerProfiles.includes(n)) {
          t.workerProfiles.push(n);
          t.addedWorkerProfiles.push(n);
        }
      }
      changed();
      return ok(structuredClone(t));
    }),
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
      if (seed.foreignTmux?.includes(input.name)) return fail('name_in_tmux', tmuxTaken(input.name), 'name');
      if (!input.dir) return fail('dir_required', 'Choose the agent’s folder.', 'dir');
      const a: LongAgent = { ...input, createdAt: clock++ };
      st.agents.push(a);
      changed();
      return ok(a);
    }),
    startAgent: vi.fn(async (name: string) => (seed.foreignTmux?.includes(name) ? fail('name_in_tmux', tmuxTaken(name)) : ok(null))),
    stopAgent: vi.fn(async (_name: string) => ok(null)),
    removeAgent: vi.fn(async (name: string) => {
      st.agents = st.agents.filter((a) => a.name !== name);
      changed();
      return ok(null);
    }),
    renameAgent: vi.fn(async (name: string, to: string) => {
      const a = st.agents.find((x) => x.name === name)!;
      if (!SLUG_PATTERN.test(to)) return fail('name_invalid', 'Use lowercase letters, digits and dashes.', 'name');
      if (st.agents.some((x) => x.name === to)) return fail('name_taken', 'An agent with this name exists.', 'name');
      if (seed.foreignTmux?.includes(to)) return fail('name_in_tmux', tmuxTaken(to), 'name');
      a.name = to;
      changed();
      return ok({ ...a });
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
    // Lesson kinds, as the contract says: labels hopp.about / hopp.project.
    setLessonAbout: vi.fn(async (id: number, about: 'hopp' | 'project' | null) => {
      lessons = lessons.map((l) => {
        if (l.id !== id) return l;
        const labels = { ...l.labels };
        if (about) labels['hopp.about'] = about;
        else delete labels['hopp.about'];
        return { ...l, labels };
      });
      return ok(null);
    }),
    setLessonProject: vi.fn(async (id: number, slug: string | null) => {
      lessons = lessons.map((l) => {
        if (l.id !== id) return l;
        const labels = { ...l.labels };
        if (slug) labels['hopp.project'] = slug;
        else delete labels['hopp.project'];
        return { ...l, labels };
      });
      return ok(null);
    }),
    lessonToGuardrails: vi.fn(async (id: number) => {
      const l = lessons.find((x) => x.id === id);
      const p = st.projects.find((x) => x.slug === l?.labels['hopp.project']);
      if (!l || !p) return fail('lesson_no_project', 'The lesson is not about a project');
      p.guardrails = (p.guardrails ? p.guardrails.replace(/\n*$/, '\n') : '') + '- ' + l.body.trim() + '\n';
      lessons = lessons.map((x) => (x.id === id ? { ...x, status: 'closed' as const, closed_at: 2 } : x));
      changed();
      return ok(null);
    }),
    triageLessonsBrief: vi.fn(async (slug: string) => `Разбери открытые уроки проекта ${slug}: hopp lessons --project ${slug}.`),
    // GitHub: off by default in page tests (stubs added with the contract).
    githubStatus: vi.fn(async () => ({ ...ghStatus })),
    listGithubRepos: vi.fn(async (q: string) => {
      const n = q.trim().toLowerCase();
      return ok(ghRepos.filter((r) => !n || r.fullName.toLowerCase().includes(n) || r.description.toLowerCase().includes(n)));
    }),
    addGithubRepo: vi.fn(async (fullName: string): Promise<Result<{ path: string }>> => {
      if (seed.github?.add) return seed.github.add(fullName);
      const folder = managedRepoFolder(fullName);
      if (!folder) return fail('repo_unknown', `No repository ${fullName}`);
      return ok({ path: `${ghStatus.home}/repos/${folder}` });
    }),
    // Model profiles (stubs added with the contract; replace as needed).
    onProfilesChanged: vi.fn((cb: () => void) => {
      profileCbs.add(cb);
      return () => profileCbs.delete(cb);
    }),
    setProfileEnabled: vi.fn(async (name: string, enabled: boolean): Promise<Result<ModelProfile>> => {
      const p = profiles.find((x) => x.name === name);
      if (!p) return fail('profile_not_found', `No profile ${name}`);
      if (!enabled && p.isDefault) return fail('profile_is_default', `${name} is the default profile; make another one the default first.`);
      p.enabled = enabled;
      profilesChanged();
      return ok(structuredClone(p));
    }),
    updateProfile: vi.fn(async (name: string, u: ProfileUpdate): Promise<Result<ModelProfile>> => {
      const p = profiles.find((x) => x.name === name);
      if (!p) return fail('profile_not_found', `No profile ${name}`);
      if (u.effort === 'bogus') return fail('bad_effort', `The model does not take effort "bogus".`);
      Object.assign(p, u);
      profilesChanged();
      return ok(structuredClone(p));
    }),
    setDefaultProfile: vi.fn(async (name: string): Promise<Result<null>> => {
      const p = profiles.find((x) => x.name === name);
      if (!p) return fail('profile_not_found', `No profile ${name}`);
      if (!p.enabled) return fail('profile_disabled', `${name} is switched off.`);
      for (const x of profiles) x.isDefault = x.name === name;
      profilesChanged();
      return ok(null);
    }),
    removeProfile: vi.fn(async (name: string): Promise<Result<null>> => {
      if (seed.profilesInUse?.includes(name)) return fail('profile_in_use', `${name} is used by the running session lead.`);
      profiles = profiles.filter((x) => x.name !== name);
      profilesChanged();
      return ok(null);
    }),
    moveProfile: vi.fn(async (name: string, position: number): Promise<Result<null>> => {
      const order = [...profiles].sort((a, b) => a.position - b.position).filter((x) => x.name !== name);
      const p = profiles.find((x) => x.name === name);
      if (!p) return fail('profile_not_found', `No profile ${name}`);
      order.splice(Math.max(0, Math.min(position, order.length)), 0, p);
      order.forEach((x, i) => (x.position = i));
      profilesChanged();
      return ok(null);
    }),
    modelCatalog: vi.fn(async () => ok(structuredClone(seed.catalog ?? []))),
    importModels: vi.fn(async (): Promise<Result<ImportResult>> => {
      const r = seed.importResult ?? { added: [], skipped: 0, failed: [] };
      profiles = [...profiles, ...structuredClone(r.added).filter((a) => !profiles.some((p) => p.name === a.name))];
      if (r.added.length) profilesChanged();
      return ok(structuredClone(r));
    }),
    // models-add, with the main process's naming and the refusals that
    // matter to the form (taken name, effort not offered).
    addProfile: vi.fn(async (input: NewProfileInput) => addFake(input, null)),
    copyProfile: vi.fn(async (name: string, input: CopyProfileInput) => {
      const src = profiles.find((p) => p.name === name);
      if (!src) return fail('profile_not_found', `No profile ${name}`);
      return addFake({ name: input.name, agent: src.agent, model: src.model, effort: input.effort ?? src.effort, description: input.description ?? src.description }, src);
    }),
  } satisfies ShellBridge;

  function addFake(input: NewProfileInput, src: ModelProfile | null): Result<ModelProfile> {
    const taken = new Set(profiles.map((p) => p.name));
    const model = input.model.trim();
    if (!model) return fail('model_required', 'Name the model: one from the list or the id the harness takes', 'model');
    const effort = input.effort ?? '';
    const listed = (seed.catalog ?? []).find((c) => c.agent === input.agent)?.models.find((m) => m.id === model);
    const levels = listed ? listed.efforts : (HARNESS_EFFORTS[input.agent] ?? []);
    if (effort && !levels.includes(effort)) return fail('bad_effort', `Effort ${effort} is not offered for ${model}`, 'effort');
    const name = input.name?.trim() || (src ? copyProfileName(src, effort, taken) : newProfileName(input.agent, model, effort, taken));
    if (taken.has(name)) return fail('name_taken', `A profile named ${name} exists`, 'name');
    const p: ModelProfile = {
      name, agent: input.agent, model, effort, description: input.description, enabled: input.enabled ?? true,
      position: profiles.reduce((m, x) => Math.max(m, x.position + 1), 0), isDefault: false,
    };
    profiles = [...profiles, p];
    profilesChanged();
    return ok(structuredClone(p));
  }

  return {
    shell,
    st,
    feeds,
    feedChanged,
    // Which paths exist, for attachments (a file deleted before sending).
    setPath(p: string, kind: 'file' | 'dir' | null) {
      if (kind) paths[p] = kind;
      else delete paths[p];
    },
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
    dismissAsk: vi.fn(async (id: number) => {
      const a = db.asks.find((x) => x.id === id)!;
      Object.assign(a, { status: 'withdrawn', reason: 'dismissed' });
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
    feeds: fs?.feeds,
    feedChanged: fs?.feedChanged,
    setShell: fs?.set,
    setPath: fs?.setPath,
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

function tmuxTaken(name: string): string {
  return `A tmux session named ${name} already runs outside hopp. Choose another name, or close that session.`;
}
