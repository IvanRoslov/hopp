// ShellService implements the shell layer for the page: projects, tasks and
// long-lived agents on top of the daemon, the tool catalog and git. The store
// keeps only what the daemon cannot know; a task's state on screen comes from
// its sessions.
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type {
  LongAgent,
  LongAgentInput,
  ModelProfile,
  Project,
  ProjectInput,
  Result,
  ShellState,
  Task,
  TaskInput,
  ToolCatalog,
  ToolRules,
  Lesson,
  Artifact,
  Pipeline,
  PipelineInput,
  Post,
  SubmissionAnswer,
  TaskFeed,
} from '../../shared/shell';
import { ACCEPT, LABEL, RETURN } from '../../shared/shell';
import { SLUG_PATTERN, slugify } from '../../shared/slug';
import type { Ask, DaemonEvent, Session, Waiting } from '../../shared/types';
import { DaemonError, DaemonUnavailable, type DaemonClient } from '../daemon/client';
import { RunError, type Runner } from './exec';
import { starterPipelines, validatePipeline } from './pipelines';
import { expandHome, fail, MAX_SLUG, validateProject } from './projects';
import { agentText, allowedRepos, orchestratorText, workerText, type WorkerFile } from './startText';
import type { ShellStore } from './store';

export interface ShellDeps {
  home: string;
  store: ShellStore;
  client: DaemonClient;
  git: Runner;
  hopp: Runner;
  pickFolder: () => Promise<string | null>;
  now?: () => number;
}

const LIVE = new Set(['spawning', 'running']);
const FEED_EVENTS = new Set(['post.added', 'ask.created', 'ask.answered', 'ask.withdrawn', 'artifact.published']);
const TEXT_MAX = 2 * 1024 * 1024;

// looksText: a text MIME type, or no NUL byte in the first 8 KB.
function looksText(mime: string, buf: Buffer): boolean {
  if (/^text\/|json|xml|javascript|svg|yaml|markdown/.test(mime)) return true;
  return !buf.subarray(0, 8192).includes(0);
}
export const MAX_ID = 40;
export const TITLE_MAX = 60;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

// errorResult turns anything thrown into a Result the page can show.
export function errorResult<T>(err: unknown): Result<T> {
  if (err instanceof DaemonUnavailable) return fail('daemon_unavailable', 'The hopp daemon is not running. Start it and try again.');
  if (err instanceof DaemonError) return fail(err.code, err.message);
  if (err instanceof RunError) return fail('command_failed', err.message);
  return fail('internal_error', err instanceof Error ? err.message : String(err));
}

async function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (err) {
    return errorResult<T>(err);
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, path);
}

// taskTitle: the given title, else the brief's first line cut to 60.
export function taskTitle(input: Pick<TaskInput, 'title' | 'brief'>): string {
  const t = (input.title ?? '').trim();
  if (t) return t.split('\n')[0]!.slice(0, 200);
  const first = (input.brief ?? '').trim().split('\n')[0]!.trim();
  return [...first].slice(0, TITLE_MAX).join('').trim();
}

// uniqueId returns base, or base-2, base-3, … : the first that taken()
// refuses, each at most MAX_ID characters.
export async function uniqueId(base: string, taken: (id: string) => Promise<boolean> | boolean): Promise<string> {
  const cut = (s: string, n: number) => s.slice(0, n).replace(/-+$/, '');
  let id = cut(base, MAX_ID);
  for (let n = 2; await taken(id); n++) {
    const suffix = '-' + n;
    id = cut(base, MAX_ID - suffix.length) + suffix;
  }
  return id;
}

export class ShellService {
  private readonly now: () => number;

  constructor(private readonly d: ShellDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get home(): string {
    return this.d.home;
  }

  state(): Promise<ShellState> {
    return this.d.store.read();
  }

  onChanged(cb: (s: ShellState) => void): () => void {
    return this.d.store.onChanged(cb);
  }

  pickFolder(): Promise<string | null> {
    return this.d.pickFolder();
  }

  // ---- projects -----------------------------------------------------------

  createProject(input: ProjectInput): Promise<Result<Project>> {
    return guard(() =>
      this.d.store.update(async (st) => {
        const r = await validateProject(input, st.projects, this.d.git, this.now());
        if (r.ok) st.projects.push(r.value);
        else throw new Refused(r);
        return r;
      }).catch(refusedResult<Project>),
    );
  }

  updateProject(slug: string, input: ProjectInput): Promise<Result<Project>> {
    return guard(() =>
      this.d.store.update(async (st) => {
        const i = st.projects.findIndex((p) => p.slug === slug);
        if (i < 0) throw new Refused(fail('project_not_found', `No project "${slug}"`));
        const hasTasks = st.tasks.some((t) => t.projectSlug === slug);
        const r = await validateProject(input, st.projects, this.d.git, this.now(), { project: st.projects[i]!, hasTasks });
        if (!r.ok) throw new Refused(r);
        st.projects[i] = r.value;
        return r;
      }).catch(refusedResult<Project>),
    );
  }

  removeProject(slug: string): Promise<Result<null>> {
    return guard(() =>
      this.d.store.update((st) => {
        if (!st.projects.some((p) => p.slug === slug)) throw new Refused(fail('project_not_found', `No project "${slug}"`));
        const n = st.tasks.filter((t) => t.projectSlug === slug && !t.hidden).length;
        if (n > 0) throw new Refused(fail('project_has_tasks', `The project still has ${n} task${n === 1 ? '' : 's'} in the list; remove them from the list first`));
        st.projects = st.projects.filter((p) => p.slug !== slug);
        return ok(null);
      }).catch(refusedResult<null>),
    );
  }

  // ---- profiles -----------------------------------------------------------

  async listProfiles(): Promise<ModelProfile[]> {
    const { profiles } = await this.d.client.listModelProfiles();
    return [...profiles.filter((p) => p.enabled), ...profiles.filter((p) => !p.enabled)];
  }

  // ---- tasks --------------------------------------------------------------

  // Launches run one at a time, so two launches never pick the same id.
  private launches: Promise<unknown> = Promise.resolve();

  createTask(input: TaskInput): Promise<Result<Task>> {
    const run = () => guard(() => this.launchTask(input));
    const p = this.launches.then(run, run);
    this.launches = p.catch(() => undefined);
    return p;
  }

  private async launchTask(input: TaskInput): Promise<Result<Task>> {
    const st = await this.d.store.read();
    const project = st.projects.find((p) => p.slug === input.projectSlug);
    if (!project) return fail('project_not_found', 'Choose a project', 'projectSlug');
    const brief = (input.brief ?? '').trim();
    if (!brief) return fail('brief_required', 'Say what needs to be done', 'brief');

    const profiles = await this.listProfiles();
    const enabled = new Map(profiles.filter((p) => p.enabled).map((p) => [p.name, p]));
    const orch = enabled.get(input.orchestratorProfile);
    if (!orch) return fail('profile_unknown', `Choose an enabled profile for the orchestrator`, 'orchestratorProfile');
    const workerNames = input.workerProfiles && input.workerProfiles.length > 0 ? [...new Set(input.workerProfiles)] : [orch.name];
    const workers: ModelProfile[] = [];
    for (const n of workerNames) {
      const p = enabled.get(n);
      if (!p) return fail('profile_unknown', `"${n}" is not an enabled profile`, 'workerProfiles');
      workers.push(p);
    }

    let pipeline: Pipeline | null = null;
    if (input.pipelineId) {
      pipeline = st.pipelines.find((p) => p.id === input.pipelineId) ?? null;
      if (!pipeline) return fail('pipeline_not_found', 'Choose a pipeline, or No pipeline', 'pipelineId');
      pipeline = structuredClone(pipeline);
    }

    const title = taskTitle({ title: input.title, brief });
    let base: string;
    const sessionName = (input.sessionName ?? '').trim();
    if (sessionName) {
      if (!SLUG_PATTERN.test(sessionName) || sessionName.length > MAX_ID) {
        return fail('session_name_invalid', `The session name must start with a letter and use only a-z, 0-9 and dashes, at most ${MAX_ID} characters`, 'sessionName');
      }
      base = sessionName;
    } else {
      base = slugify(title, MAX_ID) || 'task';
    }

    const worktreesDir = join(this.d.home, 'worktrees', project.slug);
    const workDir = (id: string) => (project.orchestratorRepo ? join(worktreesDir, id) : join(this.d.home, 'work', project.slug, id));
    const sessions = await this.d.client.listSessions({ all: true });
    const mailboxes = await this.d.client.listMailboxes();
    const used = new Set<string>([
      ...sessions.map((s) => s.id),
      ...st.tasks.map((t) => t.sessionId),
      ...st.agents.map((a) => a.name),
      ...mailboxes.map((b) => b.name),
    ]);
    const id = await uniqueId(base, async (c) => {
      if (used.has(c) || existsSync(workDir(c)) || existsSync(join(this.d.home, 'shell', 'tasks', c))) return true;
      if (project.orchestratorRepo) return this.branchExists(project.orchestratorRepo, 'hopp/' + c);
      return false;
    });

    // Tools sections, one per harness, before anything is written.
    const harnesses = [...new Set([orch.agent, ...workers.map((w) => w.agent)])];
    const toolsPrompt = new Map<string, string>();
    for (const h of harnesses) toolsPrompt.set(h, await this.toolsPromptFor(h));

    const dir = workDir(id);
    const textsDir = join(this.d.home, 'shell', 'tasks', id);
    const made = { worktree: false, folder: false, texts: false };
    try {
      await mkdir(worktreesDir, { recursive: true });
      if (project.orchestratorRepo) {
        await this.d.git(['-C', project.orchestratorRepo, 'worktree', 'add', '-b', 'hopp/' + id, dir, 'HEAD']);
        made.worktree = true;
      } else {
        await mkdir(join(this.d.home, 'work', project.slug), { recursive: true });
        await mkdir(dir);
        made.folder = true;
      }

      await mkdir(textsDir, { recursive: true });
      made.texts = true;
      const workerFiles: WorkerFile[] = [];
      for (const w of workers) {
        const file = join(textsDir, `worker-${w.agent}.md`);
        if (!workerFiles.some((f) => f.file === file)) {
          await writeAtomic(file, workerText({ project, taskId: id, title, toolsPrompt: toolsPrompt.get(w.agent) ?? '' }));
        }
        workerFiles.push({ profile: w.name, harness: w.agent, file });
      }
      const systemPrompt = orchestratorText({
        project, taskId: id, title, taskDir: dir, worktreesDir, workers: workerFiles,
        toolsPrompt: toolsPrompt.get(orch.agent) ?? '', extraSystemPrompt: input.extraSystemPrompt, pipeline,
      });
      await writeAtomic(join(textsDir, 'orchestrator.md'), systemPrompt);

      const spawnDirs = [...new Set([...allowedRepos(project), worktreesDir, dir])];
      await this.d.client.createSession({
        dir, id, profile: orch.name,
        labels: { 'hopp.project': project.slug, 'hopp.task': id, 'hopp.role': 'orchestrator' },
        spawn_dirs: spawnDirs, system_prompt: systemPrompt, message: brief,
      });
    } catch (err) {
      await this.undoLaunch(project, id, dir, textsDir, made);
      return errorResult(err);
    }

    const task: Task = {
      id, projectSlug: project.slug, title, brief, sessionId: id, dir,
      branch: project.orchestratorRepo ? 'hopp/' + id : null,
      orchestratorProfile: orch.name, workerProfiles: workers.map((w) => w.name), pipeline,
      status: 'active', hidden: false, createdAt: this.now(), finishedAt: 0,
    };
    await this.d.store.update((s) => {
      s.tasks.push(task);
    });
    return ok(task);
  }

  // undoLaunch removes exactly what a failed launch made, and nothing else.
  private async undoLaunch(
    project: Project,
    id: string,
    dir: string,
    textsDir: string,
    made: { worktree: boolean; folder: boolean; texts: boolean },
  ): Promise<void> {
    const quiet = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch {
        // best effort: the error that caused the undo is the one to report
      }
    };
    if (made.worktree && project.orchestratorRepo) {
      await quiet(() => this.d.git(['-C', project.orchestratorRepo!, 'worktree', 'remove', '--force', dir]));
      await quiet(() => this.d.git(['-C', project.orchestratorRepo!, 'branch', '-D', 'hopp/' + id]));
    }
    if (made.folder) await quiet(() => rm(dir, { recursive: true, force: true }));
    if (made.texts) await quiet(() => rm(textsDir, { recursive: true, force: true }));
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.d.git(['-C', repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]);
      return true;
    } catch {
      return false;
    }
  }

  private async toolsPromptFor(harness: string): Promise<string> {
    try {
      return (await this.d.hopp(['tools', 'prompt', '--harness', harness])).stdout;
    } catch (err) {
      throw new RunError('Could not read the tool catalog (hopp tools prompt): ' + (err as Error).message);
    }
  }

  private async findTask(id: string): Promise<Task | null> {
    return (await this.d.store.read()).tasks.find((t) => t.id === id) ?? null;
  }

  private async sessionOrNull(id: string): Promise<Session | null> {
    try {
      return await this.d.client.getSession(id);
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404) return null;
      throw err;
    }
  }

  stopTask(id: string): Promise<Result<null>> {
    return guard(async () => {
      const t = await this.findTask(id);
      if (!t) return fail('task_not_found', `No task "${id}"`);
      const s = await this.sessionOrNull(t.sessionId);
      if (!s) return fail('session_missing', `The task's session ${t.sessionId} is gone from the daemon`);
      await this.d.client.killSession(t.sessionId);
      return ok(null);
    });
  }

  resumeTask(id: string): Promise<Result<null>> {
    return guard(async () => {
      const t = await this.findTask(id);
      if (!t) return fail('task_not_found', `No task "${id}"`);
      if (t.status === 'finished') return fail('task_finished', 'A finished task cannot be resumed');
      const s = await this.sessionOrNull(t.sessionId);
      if (!s) return fail('session_missing', `The task's session ${t.sessionId} is gone from the daemon`);
      if (LIVE.has(s.state)) return ok(null);
      await this.d.client.restoreSession(t.sessionId);
      return ok(null);
    });
  }

  finishTask(id: string): Promise<Result<null>> {
    return guard(async () => {
      const t = await this.findTask(id);
      if (!t) return fail('task_not_found', `No task "${id}"`);
      const s = await this.sessionOrNull(t.sessionId);
      if (s && LIVE.has(s.state)) await this.d.client.killSession(t.sessionId, 'done');
      await this.d.store.update((st) => {
        const x = st.tasks.find((k) => k.id === id);
        if (x && x.status !== 'finished') {
          x.status = 'finished';
          x.finishedAt = this.now();
        }
      });
      return ok(null);
    });
  }

  hideTask(id: string): Promise<Result<null>> {
    return guard(async () => {
      const t = await this.findTask(id);
      if (!t) return fail('task_not_found', `No task "${id}"`);
      const s = await this.sessionOrNull(t.sessionId);
      if (s && LIVE.has(s.state)) return fail('task_running', 'Stop or finish the task before removing it from the list');
      await this.d.store.update((st) => {
        const x = st.tasks.find((k) => k.id === id);
        if (x) x.hidden = true;
      });
      return ok(null);
    });
  }

  // ---- long-lived agents ----------------------------------------------------

  createAgent(input: LongAgentInput): Promise<Result<LongAgent>> {
    return guard(async () => {
      const name = (input.name ?? '').trim();
      if (!name || !SLUG_PATTERN.test(name) || name.length > MAX_SLUG) {
        return fail('name_invalid', `The name must start with a letter and use only a-z, 0-9 and dashes, at most ${MAX_SLUG} characters`, 'name');
      }
      const st = await this.d.store.read();
      if (st.agents.some((a) => a.name === name)) return fail('name_taken', `An agent named "${name}" exists`, 'name');
      if (st.tasks.some((t) => t.sessionId === name)) return fail('name_taken', `"${name}" is the session of a task`, 'name');
      const profiles = await this.listProfiles();
      if (!profiles.some((p) => p.enabled && p.name === input.profile)) return fail('profile_unknown', 'Choose an enabled profile', 'profile');
      const dir = expandHome((input.dir ?? '').trim());
      if (!dir || !isAbsolute(dir) || !(await isDir(dir))) return fail('folder_missing', 'Choose an existing folder', 'dir');
      try {
        await this.d.client.addMailbox(name);
      } catch (err) {
        if (!(err instanceof DaemonError && err.code === 'mailbox_exists')) throw err;
      }
      const agent: LongAgent = { name, profile: input.profile, dir, createdAt: this.now() };
      return this.d.store.update((s) => {
        if (s.agents.some((a) => a.name === name)) throw new Refused(fail('name_taken', `An agent named "${name}" exists`, 'name'));
        s.agents.push(agent);
        return ok(agent);
      }).catch(refusedResult<LongAgent>);
    });
  }

  startAgent(name: string): Promise<Result<null>> {
    return guard(async () => {
      const a = (await this.d.store.read()).agents.find((x) => x.name === name);
      if (!a) return fail('agent_not_found', `No agent "${name}"`);
      const s = await this.sessionOrNull(name);
      if (s) {
        if (LIVE.has(s.state)) return ok(null);
        if (s.state === 'done') {
          return fail('agent_done', `The session "${name}" ended as done and cannot be restored; remove its record with \`hopp rm ${name}\` to start it fresh`);
        }
        await this.d.client.restoreSession(name);
        return ok(null);
      }
      const prof = (await this.listProfiles()).find((p) => p.name === a.profile);
      if (!prof || !prof.enabled) return fail('profile_unknown', `The agent's profile "${a.profile}" is not enabled`);
      await this.d.client.createSession({
        dir: a.dir, id: name, profile: a.profile, labels: { 'hopp.agent': name },
        system_prompt: agentText({ toolsPrompt: await this.toolsPromptFor(prof.agent) }),
      });
      return ok(null);
    });
  }

  stopAgent(name: string): Promise<Result<null>> {
    return guard(async () => {
      const a = (await this.d.store.read()).agents.find((x) => x.name === name);
      if (!a) return fail('agent_not_found', `No agent "${name}"`);
      const s = await this.sessionOrNull(name);
      if (s && LIVE.has(s.state)) await this.d.client.killSession(name);
      return ok(null);
    });
  }

  removeAgent(name: string): Promise<Result<null>> {
    return guard(async () => {
      const a = (await this.d.store.read()).agents.find((x) => x.name === name);
      if (!a) return fail('agent_not_found', `No agent "${name}"`);
      const s = await this.sessionOrNull(name);
      if (s && LIVE.has(s.state)) return fail('agent_running', 'Stop the agent before removing it');
      await this.d.store.update((st) => {
        st.agents = st.agents.filter((x) => x.name !== name);
      });
      return ok(null);
    });
  }

  async agentMail(): Promise<Record<string, number>> {
    const st = await this.d.store.read();
    if (st.agents.length === 0) return {};
    const [boxes, sessions] = await Promise.all([this.d.client.listMailboxes(), this.d.client.listSessions()]);
    const live = new Set(sessions.filter((s) => LIVE.has(s.state)).map((s) => s.id));
    const out: Record<string, number> = {};
    for (const a of st.agents) {
      if (live.has(a.name)) continue;
      out[a.name] = boxes.find((b) => b.name === a.name)?.unread ?? 0;
    }
    return out;
  }

  waiting(): Promise<Waiting> {
    return this.d.client.waiting();
  }

  // ---- tools ----------------------------------------------------------------

  async listTools(): Promise<ToolCatalog> {
    const r = await this.d.hopp(['--json', 'tools', 'list', '--all']);
    const parsed = JSON.parse(r.stdout) as Partial<ToolCatalog>;
    return { tools: parsed.tools ?? [], broken: parsed.broken ?? [] };
  }

  async toolUsage(name: string): Promise<string> {
    const r = await this.d.hopp(['--json', 'tools', 'show', name, '--all']);
    return (JSON.parse(r.stdout) as { usage?: string }).usage ?? '';
  }

  setToolEnabled(name: string, enabled: boolean): Promise<Result<null>> {
    return guard(async () => {
      await this.d.hopp(['tools', enabled ? 'enable' : 'disable', name]);
      return ok(null);
    });
  }

  async toolRules(): Promise<ToolRules> {
    const r = await this.d.hopp(['--json', 'tools', 'rules']);
    const p = JSON.parse(r.stdout) as { text?: string; modified_at?: number };
    return { text: p.text ?? '', modifiedAt: p.modified_at ?? 0 };
  }

  setToolRules(text: string): Promise<Result<ToolRules>> {
    return guard(async () => {
      const dir = join(this.d.home, 'tools');
      await mkdir(dir, { recursive: true });
      const body = text.length > 0 && !text.endsWith('\n') ? text + '\n' : text;
      await writeAtomic(join(dir, 'rules.md'), body);
      return ok(await this.toolRules());
    });
  }

  // ---- lessons --------------------------------------------------------------

  listLessons(status: 'new' | 'closed' | 'all'): Promise<Lesson[]> {
    return this.d.client.listLessons(status);
  }

  closeLesson(id: number): Promise<Result<null>> {
    return guard(async () => {
      await this.d.client.closeLesson(id);
      return ok(null);
    });
  }

  // ---- pipelines -------------------------------------------------------------

  // seedPipelines adds the starter pipelines once, to a store that has none.
  async seedPipelines(): Promise<boolean> {
    return this.d.store.seedOnce('starter-pipelines', (st) => {
      if (st.pipelines.length === 0) st.pipelines.push(...starterPipelines(this.now()));
    });
  }

  createPipeline(input: PipelineInput): Promise<Result<Pipeline>> {
    return guard(() =>
      this.d.store.update((st) => {
        const r = validatePipeline(input, st.pipelines, this.now());
        if (!r.ok) throw new Refused(r);
        st.pipelines.push(r.value);
        return r;
      }).catch(refusedResult<Pipeline>),
    );
  }

  updatePipeline(id: string, input: PipelineInput): Promise<Result<Pipeline>> {
    return guard(() =>
      this.d.store.update((st) => {
        const i = st.pipelines.findIndex((p) => p.id === id);
        if (i < 0) throw new Refused(fail('pipeline_not_found', `No pipeline "${id}"`));
        const r = validatePipeline(input, st.pipelines, this.now(), st.pipelines[i]);
        if (!r.ok) throw new Refused(r);
        st.pipelines[i] = r.value;
        return r;
      }).catch(refusedResult<Pipeline>),
    );
  }

  removePipeline(id: string): Promise<Result<null>> {
    return guard(() =>
      this.d.store.update((st) => {
        if (!st.pipelines.some((p) => p.id === id)) throw new Refused(fail('pipeline_not_found', `No pipeline "${id}"`));
        st.pipelines = st.pipelines.filter((p) => p.id !== id);
        return ok(null);
      }).catch(refusedResult<null>),
    );
  }

  // ---- the feed --------------------------------------------------------------

  async taskFeed(taskId: string): Promise<TaskFeed> {
    const t = await this.findTask(taskId);
    if (!t) throw new Error(`No task "${taskId}"`);
    const labels = { [LABEL.task]: t.id };
    const posts: Post[] = [];
    for (let after = 0; ; ) {
      const page = await this.d.client.listPosts({ labels, after, limit: 500 });
      posts.push(...page);
      if (page.length < 500) break;
      after = page[page.length - 1]!.id;
    }
    const [asks, stored] = await Promise.all([
      this.d.client.listAsks({ status: 'all', labels }),
      this.d.client.listArtifacts({ scope: t.sessionId, versions: true }),
    ]);
    const artifacts: Artifact[] = stored.map(({ path: _path, ...a }) => a);
    const byTime = <T extends { id: number; created_at: number }>(a: T, b: T) => a.created_at - b.created_at || a.id - b.id;
    return { posts: posts.sort(byTime), asks: [...asks].sort(byTime), artifacts: artifacts.sort(byTime) };
  }

  postToTask(taskId: string, text: string, stageId?: string): Promise<Result<Post>> {
    return guard(async () => {
      const t = await this.findTask(taskId);
      if (!t) return fail('task_not_found', `No task "${taskId}"`);
      const body = text.trim();
      if (!body) return fail('text_required', 'Write something first', 'text');
      if (stageId && !t.pipeline?.stages.some((s) => s.id === stageId)) return fail('stage_unknown', `The task has no stage "${stageId}"`);
      const s = await this.sessionOrNull(t.sessionId);
      if (!s || !LIVE.has(s.state)) return fail('orchestrator_not_running', 'The orchestrator is not running; resume the task to write to it');
      await this.d.client.sendMessage({ to: t.sessionId, body });
      const labels: Record<string, string> = { [LABEL.project]: t.projectSlug, [LABEL.task]: t.id };
      if (stageId) labels[LABEL.stage] = stageId;
      return ok(await this.d.client.createPost({ from: '', body, labels }));
    });
  }

  answerSubmission(askId: number, answer: SubmissionAnswer): Promise<Result<Ask>> {
    return guard(async () => {
      if (answer.choice === 'Return') {
        const text = (answer.text ?? '').trim();
        if (!text) return fail('text_required', 'Say what should be fixed', 'text');
        return ok(await this.d.client.answerAsk(askId, { choice: RETURN, answer: text }));
      }
      return ok(await this.d.client.answerAsk(askId, { choice: ACCEPT }));
    });
  }

  // feedTaskOf names the task a daemon event belongs to, from the labels the
  // event carries (the item's own, then the session's); null when none.
  feedTaskOf(e: DaemonEvent): string | null {
    if (!FEED_EVENTS.has(e.type)) return null;
    const data = e.data ?? {};
    for (const key of ['post_labels', 'ask_labels', 'artifact_labels', 'labels']) {
      const l = data[key] as Record<string, unknown> | undefined;
      const t = l && typeof l[LABEL.task] === 'string' ? (l[LABEL.task] as string) : '';
      if (t) return t;
    }
    return null;
  }

  // ---- artifacts ---------------------------------------------------------------

  // artifactFile returns the stored file of an artifact version, only when it
  // lies inside $HOPP_HOME/artifacts.
  async artifactFile(id: number): Promise<{ path: string; mime: string; size: number }> {
    const a = await this.d.client.getArtifact(id);
    const root = await realpath(join(this.d.home, 'artifacts'));
    const real = await realpath(a.path);
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('artifact file is outside the artifacts folder');
    const info = await stat(real);
    if (!info.isFile()) throw new Error('artifact is not a file');
    return { path: real, mime: a.mime || 'application/octet-stream', size: info.size };
  }

  artifactText(id: number): Promise<Result<string>> {
    return guard(async () => {
      const f = await this.artifactFile(id);
      if (f.size > TEXT_MAX) return fail('too_large', 'The file is larger than 2 MB; open it with a viewer instead');
      const buf = await readFile(f.path);
      if (!looksText(f.mime, buf)) return fail('not_text', 'The file is not text');
      return ok(buf.toString('utf8'));
    });
  }
}

// Refused carries a refusal out of a store update, so the update writes
// nothing and the caller still gets the Result.
class Refused<T> extends Error {
  constructor(readonly result: Result<T>) {
    super('refused');
  }
}

function refusedResult<T>(err: unknown): Result<T> {
  if (err instanceof Refused) return err.result as Result<T>;
  throw err;
}
