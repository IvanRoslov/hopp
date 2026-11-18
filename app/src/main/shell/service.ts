// ShellService implements the shell layer for the page: projects, tasks and
// long-lived agents on top of the daemon, the tool catalog and git. The store
// keeps only what the daemon cannot know; a task's state on screen comes from
// its sessions.
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type {
  LongAgent,
  LongAgentInput,
  ModelProfile,
  Project,
  ProjectInput,
  Result,
  ShellState,
  TaskBase,
  Task,
  TaskInput,
  ToolCatalog,
  ToolRules,
  Lesson,
  LessonAbout,
  NewProfileInput,
  CopyProfileInput,
  Artifact,
  GithubRepo,
  GithubStatus,
  HarnessCatalog,
  ImportResult,
  ProfileUpdate,
  Pipeline,
  PipelineInput,
  Post,
  SubmissionAnswer,
  TaskFeed,
} from '../../shared/shell';
import { HARNESS_EFFORTS, HARNESSES, LABEL } from '../../shared/shell';
import { submissionOptionKind } from '../../shared/submission';
import { SLUG_PATTERN, slugify } from '../../shared/slug';
import type { Ask, DaemonEvent, Session, Waiting } from '../../shared/types';
import { DaemonError, DaemonUnavailable, type DaemonClient } from '../daemon/client';
import { RunError, type Runner } from './exec';
import { Github } from './github';
import { copyProfileName, importProfileName, newProfileName, PROFILE_NAME_RE, uniqueProfileName } from './profiles';
import { starterPipelines, validatePipeline } from './pipelines';
import { expandHome, fail, MAX_SLUG, validateProject } from './projects';
import {
  agentText,
  allowedRepos,
  orchestratorText,
  RESUMED_AGENT,
  RESUMED_ORCHESTRATOR,
  triageLessonsBrief as triageBrief,
  workerText,
  type WorkerFile,
} from './startText';
import type { ShellStore } from './store';
import { Attachments, type FileDeps } from './attachments';
import { attachmentName, splitAttachments, type AttachmentInfo, type PasteResult } from '../../shared/attachments';

export interface ShellDeps {
  home: string;
  store: ShellStore;
  client: DaemonClient;
  git: Runner;
  hopp: Runner;
  pickFolder: () => Promise<string | null>;
  now?: () => number;
  // The user's gh CLI; absent means gh is not set up for this app.
  gh?: Runner;
  // Bound of the fetch before a task on a managed clone (default 60 s).
  fetchTimeoutMs?: number;
  // The dialog, clipboard and previews for attachments; absent outside
  // the app (the CLI's socket never offers them).
  files?: FileDeps;
  // Where a pasted image is saved (default <home>/attachments; the app
  // passes <app home>/attachments).
  attachmentsDir?: string;
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
  const f = await open(tmp, 'w', 0o644);
  try {
    await f.writeFile(text);
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// taskTitle: the given title, else the brief's first line, cut to 60
// characters at a word boundary with an ellipsis when it is longer.
export function taskTitle(input: Pick<TaskInput, 'title' | 'brief'>): string {
  const t = (input.title ?? '').trim();
  if (t) return t.split('\n')[0]!.slice(0, 200);
  // A brief that is only attachments is named after the first of them.
  const { text, items } = splitAttachments((input.brief ?? '').trim());
  const firstLine = text ? text.split('\n')[0]!.trim() : items.length ? attachmentName(items[0]!.path) : '';
  const first = [...firstLine];
  if (first.length <= TITLE_MAX) return first.join('');
  // Room for the ellipsis; back up to the last space if there is one.
  const head = first.slice(0, TITLE_MAX - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? head.slice(0, space) : head;
  return cut.replace(/[\s,;:.\-–—]+$/u, '') + '…';
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

  private readonly github: Github;
  private readonly profileListeners = new Set<() => void>();
  private readonly attachments: Attachments;

  constructor(private readonly d: ShellDeps) {
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.attachments = new Attachments(d.files, d.attachmentsDir ?? join(d.home, 'attachments'));
    const noGh: Runner = async () => {
      throw Object.assign(new RunError('program not found on PATH'), { code: 'ENOENT' });
    };
    this.github = new Github(d.home, d.gh ?? noGh, d.git, undefined, d.fetchTimeoutMs);
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

  // ---- attachments ----------------------------------------------------------

  // The open dialog for attachments: files and folders, several at once.
  pickAttachments(): Promise<AttachmentInfo[]> {
    return this.attachments.pick();
  }

  // What a paste attaches: copied files and folders, or a pasted image saved
  // under <app home>/attachments.
  pasteAttachments(): Promise<PasteResult> {
    return this.attachments.paste();
  }

  // Each path as it is now: a folder or a file, missing or not.
  describePaths(paths: string[]): Promise<AttachmentInfo[]> {
    return this.attachments.describe(paths);
  }

  // Opens an attached path (reveal: shows it in Finder); '' or a message.
  openAttachment(path: string, reveal: boolean): Promise<string> {
    return this.attachments.open(path, reveal);
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
    const { profiles, default: def } = await this.d.client.listModelProfiles();
    const all = profiles.map((p) => ({ ...p, isDefault: p.name === def }));
    return [...all.filter((p) => p.enabled), ...all.filter((p) => !p.enabled)];
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
    const startedBy = (input.startedBy ?? '').trim() || null;
    if (startedBy) {
      const starter = await this.sessionOrNull(startedBy);
      if (!starter) return fail('starter_unknown', `The daemon has no session "${startedBy}" (the starting agent, from $HOPP_SESSION_ID)`);
      const role = starter.labels?.[LABEL.role];
      if (role === 'orchestrator' || role === 'worker') {
        return fail('starter_not_allowed', `${startedBy} is ${role === 'orchestrator' ? 'an orchestrator' : 'a worker'} of a task, and tasks are not started from inside tasks. Ask your orchestrator or the human instead.`);
      }
    }

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
    const isTaken = async (c: string) => {
      if (used.has(c) || existsSync(workDir(c)) || existsSync(join(this.d.home, 'shell', 'tasks', c))) return true;
      if (project.orchestratorRepo) return this.branchExists(project.orchestratorRepo, 'hopp/' + c);
      return false;
    };
    let id = await uniqueId(base, isTaken);

    // Tools sections, one per harness, before anything is written.
    const harnesses = [...new Set([orch.agent, ...workers.map((w) => w.agent)])];
    const toolsPrompt = new Map<string, string>();
    for (const h of harnesses) toolsPrompt.set(h, await this.toolsPromptFor(h));

    // Managed clones: fetched first, so the task and its workers start from
    // the remote's default branch; a plain folder starts from its HEAD.
    let worktreeBase = 'HEAD';
    let orchFetch: { fetched: boolean; warning: string } = { fetched: false, warning: '' };
    const repoBases: Record<string, string> = {};
    for (const repo of allowedRepos(project)) {
      if (!this.github.isManaged(repo)) continue;
      try {
        const prep = await this.github.prepare(repo);
        if (prep.warning) console.warn('hopp: ' + prep.warning);
        repoBases[repo] = prep.base;
        if (repo === project.orchestratorRepo) orchFetch = { fetched: prep.fetched, warning: prep.warning };
      } catch (err) {
        if (repo === project.orchestratorRepo) return fail('repo_empty', (err as Error).message);
        console.warn('hopp: ' + (err as Error).message);
      }
    }
    if (project.orchestratorRepo && repoBases[project.orchestratorRepo]) worktreeBase = repoBases[project.orchestratorRepo]!;

    // The id is taken by making its texts folder: mkdir is atomic, so of two
    // launches (in two processes) picking the same id only one gets it.
    const tasksDir = join(this.d.home, 'shell', 'tasks');
    await mkdir(tasksDir, { recursive: true });
    for (let tries = 0; ; tries++) {
      try {
        await mkdir(join(tasksDir, id));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries >= 20) throw err;
        used.add(id);
        id = await uniqueId(base, isTaken);
      }
    }
    const dir = workDir(id);
    const textsDir = join(tasksDir, id);
    const made = { worktree: false, folder: false, texts: true };
    let taskBase: TaskBase | null = null;
    let spawnSent = false;
    try {
      await mkdir(worktreesDir, { recursive: true });
      if (project.orchestratorRepo) {
        try {
          await this.d.git(['-C', project.orchestratorRepo, 'worktree', 'add', '-b', 'hopp/' + id, dir, worktreeBase]);
        } catch (err) {
          // git may have made the branch before the checkout failed; the
          // branch is new (uniqueId saw none), so it is this launch's.
          if (await this.branchExists(project.orchestratorRepo, 'hopp/' + id)) {
            await this.d.git(['-C', project.orchestratorRepo, 'branch', '-D', 'hopp/' + id]).catch((e) =>
              console.warn(`hopp: could not delete branch hopp/${id} in ${project.orchestratorRepo}: ${(e as Error).message}`),
            );
          }
          throw err;
        }
        made.worktree = true;
        taskBase = await this.baseOf(dir, project.orchestratorRepo, repoBases[project.orchestratorRepo] ?? null, orchFetch);
      } else {
        await mkdir(join(this.d.home, 'work', project.slug), { recursive: true });
        await mkdir(dir);
        made.folder = true;
      }

      const lessons = await this.projectLessons(project.slug);
      const workerFiles: WorkerFile[] = [];
      for (const w of workers) {
        const file = join(textsDir, `worker-${w.agent}.md`);
        if (!workerFiles.some((f) => f.file === file)) {
          await writeAtomic(file, workerText({ project, taskId: id, title, toolsPrompt: toolsPrompt.get(w.agent) ?? '', lessons }));
        }
        workerFiles.push({ profile: w.name, harness: w.agent, file });
      }
      const systemPrompt = orchestratorText({
        project, taskId: id, title, taskDir: dir, worktreesDir, workers: workerFiles,
        toolsPrompt: toolsPrompt.get(orch.agent) ?? '', extraSystemPrompt: input.extraSystemPrompt, pipeline, brief,
        repoBases, base: taskBase, startedBy, lessons,
      });
      await writeAtomic(join(textsDir, 'orchestrator.md'), systemPrompt);

      const spawnDirs = [...new Set([...allowedRepos(project), worktreesDir, dir])];
      const labels: Record<string, string> = { [LABEL.project]: project.slug, [LABEL.task]: id, [LABEL.role]: 'orchestrator' };
      if (startedBy) labels[LABEL.startedBy] = startedBy;
      spawnSent = true;
      await this.d.client.createSession({
        dir, id, profile: orch.name,
        labels,
        spawn_dirs: spawnDirs, system_prompt: systemPrompt, message: brief,
      });
    } catch (err) {
      // A spawn that may have happened is never undone under a live session.
      const outcome = spawnSent ? await this.spawnOutcome(err, id) : 'refused';
      if (outcome === 'running') {
        // The daemon launched it but its answer was lost: keep and record.
      } else if (outcome === 'unknown') {
        return fail(
          'launch_uncertain',
          `The daemon did not confirm the launch of ${id}. Its worktree is kept in ${dir}; check \`hopp ls\`, and remove the folder by hand if no session ${id} runs.`,
        );
      } else {
        await this.undoLaunch(project, id, dir, textsDir, made);
        return errorResult(err);
      }
    }

    const task: Task = {
      id, projectSlug: project.slug, title, brief, sessionId: id, dir,
      branch: project.orchestratorRepo ? 'hopp/' + id : null,
      orchestratorProfile: orch.name, workerProfiles: workers.map((w) => w.name), pipeline, base: taskBase, startedBy,
      status: 'active', hidden: false, createdAt: this.now(), finishedAt: 0,
    };
    const record = () =>
      this.d.store.update((s) => {
        if (!s.tasks.some((t) => t.id === task.id)) s.tasks.push(task);
      });
    try {
      await record().catch(() => record());
    } catch (err) {
      return fail(
        'task_not_recorded',
        `The orchestrator ${id} is running in ${dir}, but the app could not record the task: ${(err as Error).message}. Do not launch it again; stop it with \`hopp kill ${id}\` if it is not wanted.`,
      );
    }
    return ok(task);
  }

  // baseOf reads the commit a new worktree stands on. managedRef is the
  // origin/<branch> it was made from, or null for a folder (then the ref is
  // HEAD and its branch).
  private async baseOf(dir: string, repo: string, managedRef: string | null, f: { fetched: boolean; warning: string }): Promise<TaskBase | null> {
    try {
      const [commit, ts] = (await this.d.git(['-C', dir, 'log', '-1', '--format=%H %ct'])).stdout.trim().split(' ');
      let ref = managedRef ?? 'HEAD';
      if (!managedRef) {
        const branch = (await this.d.git(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
        if (branch && branch !== 'HEAD') ref = `HEAD (${branch})`;
      }
      return { ref, commit: commit ?? '', committedAt: Number(ts) || 0, fetched: managedRef ? f.fetched : false, warning: managedRef ? f.warning : '' };
    } catch {
      return null;
    }
  }

  // spawnOutcome decides, after a failed launch request, whether the session
  // exists: "refused" when the daemon said no or never got the request,
  // "running" when it exists anyway, "unknown" when the daemon cannot tell.
  private async spawnOutcome(err: unknown, id: string): Promise<'refused' | 'running' | 'unknown'> {
    if (err instanceof DaemonError && err.status >= 400 && err.status < 500) return 'refused';
    if (err instanceof DaemonUnavailable && err.neverSent) return 'refused';
    try {
      await this.d.client.getSession(id);
      return 'running';
    } catch (e) {
      if (e instanceof DaemonError && e.status === 404) return 'refused';
      return 'unknown';
    }
  }

  // undoLaunch removes exactly what a failed launch made, and nothing else.
  private async undoLaunch(
    project: Project,
    id: string,
    dir: string,
    textsDir: string,
    made: { worktree: boolean; folder: boolean; texts: boolean },
  ): Promise<void> {
    // Best effort: the error that caused the undo is the one to report, but
    // anything left behind is logged so it can be found.
    const quiet = async (what: string, f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (err) {
        console.warn(`hopp: undoing the launch of ${id}, could not ${what}: ${(err as Error).message}`);
      }
    };
    if (made.worktree && project.orchestratorRepo) {
      await quiet(`remove the worktree ${dir}`, () => this.d.git(['-C', project.orchestratorRepo!, 'worktree', 'remove', '--force', dir]));
      await quiet(`delete the branch hopp/${id}`, () => this.d.git(['-C', project.orchestratorRepo!, 'branch', '-D', 'hopp/' + id]));
    }
    if (made.folder) await quiet(`remove the folder ${dir}`, () => rm(dir, { recursive: true, force: true }));
    if (made.texts) await quiet(`remove ${textsDir}`, () => rm(textsDir, { recursive: true, force: true }));
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
      return this.tellRestarted(t.sessionId, RESUMED_ORCHESTRATOR);
    });
  }

  // tellRestarted: a restore relaunches the agent with its start text but no
  // first message and no conversation, so it would sit at an empty prompt.
  private async tellRestarted(session: string, body: string): Promise<Result<null>> {
    try {
      await this.d.client.sendMessage({ to: session, body });
    } catch (err) {
      return fail('resume_message', `${session} restarted, but telling it to continue failed: ${err instanceof Error ? err.message : String(err)}. Write to it in its terminal.`);
    }
    return ok(null);
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

  // checkAgentName: the reasons a name cannot be an agent's, field "name".
  // Besides the store, it asks the daemon whether a launch with this id
  // would be refused (a hopp session of that id in any state, or a live tmux
  // session of that name outside hopp); a daemon that cannot answer leaves
  // that to Start.
  private async checkAgentName(name: string, st: ShellState): Promise<Result<null>> {
    if (!name || !SLUG_PATTERN.test(name) || name.length > MAX_SLUG) {
      return fail('name_invalid', `The name must start with a letter and use only a-z, 0-9 and dashes, at most ${MAX_SLUG} characters`, 'name');
    }
    if (st.agents.some((a) => a.name === name)) return fail('name_taken', `An agent named "${name}" exists`, 'name');
    if (st.tasks.some((t) => t.sessionId === name)) return fail('name_taken', `"${name}" is the session of a task`, 'name');
    const holder = await this.d.client.sessionIdHolder(name);
    if (holder === 'tmux') return fail('name_in_tmux', tmuxTaken(name), 'name');
    if (holder === 'session') {
      return fail('name_taken', `hopp has a session named "${name}" from before. Choose another name, or remove that session with \`hopp rm ${name}\`.`, 'name');
    }
    return ok(null);
  }

  // dropEmptyMailbox removes a mailbox that holds no letters; one with
  // letters stays, since removing it would delete them.
  private async dropEmptyMailbox(name: string): Promise<void> {
    const box = (await this.d.client.listMailboxes()).find((b) => b.name === name);
    if (!box || box.total > 0) return;
    try {
      await this.d.client.removeMailbox(name);
    } catch (err) {
      if (!(err instanceof DaemonError && err.code === 'mailbox_not_found')) throw err;
    }
  }

  private async addAgentMailbox(name: string): Promise<void> {
    try {
      await this.d.client.addMailbox(name);
    } catch (err) {
      if (!(err instanceof DaemonError && err.code === 'mailbox_exists')) throw err;
    }
  }

  createAgent(input: LongAgentInput): Promise<Result<LongAgent>> {
    return guard(async () => {
      const name = (input.name ?? '').trim();
      const st = await this.d.store.read();
      const bad = await this.checkAgentName(name, st);
      if (!bad.ok) return bad;
      const profiles = await this.listProfiles();
      if (!profiles.some((p) => p.enabled && p.name === input.profile)) return fail('profile_unknown', 'Choose an enabled profile', 'profile');
      const dir = expandHome((input.dir ?? '').trim());
      if (!dir || !isAbsolute(dir) || !(await isDir(dir))) return fail('folder_missing', 'Choose an existing folder', 'dir');
      await this.addAgentMailbox(name);
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
        return this.tellRestarted(name, RESUMED_AGENT);
      }
      const prof = (await this.listProfiles()).find((p) => p.name === a.profile);
      if (!prof || !prof.enabled) return fail('profile_unknown', `The agent's profile "${a.profile}" is not enabled`);
      try {
        await this.d.client.createSession({
          dir: a.dir, id: name, profile: a.profile, labels: { 'hopp.agent': name },
          system_prompt: agentText({ toolsPrompt: await this.toolsPromptFor(prof.agent) }),
        });
      } catch (err) {
        // hopp has no session of this id (checked above), so the daemon
        // refused it for a live tmux session of that name outside hopp.
        if (err instanceof DaemonError && err.code === 'session_exists') return fail('name_in_tmux', tmuxTaken(name));
        throw err;
      }
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
      await this.dropEmptyMailbox(name);
      return ok(null);
    });
  }

  renameAgent(name: string, newName: string): Promise<Result<LongAgent>> {
    return guard(async () => {
      const st = await this.d.store.read();
      const a = st.agents.find((x) => x.name === name);
      if (!a) return fail('agent_not_found', `No agent "${name}"`);
      const to = (newName ?? '').trim();
      if (to === name) return ok(a);
      const s = await this.sessionOrNull(name);
      if (s && LIVE.has(s.state)) return fail('agent_running', 'Stop the agent before renaming it');
      const bad = await this.checkAgentName(to, st);
      if (!bad.ok) return bad;
      await this.addAgentMailbox(to);
      const r = await this.d.store.update((x) => {
        if (x.agents.some((k) => k.name === to)) throw new Refused(fail('name_taken', `An agent named "${to}" exists`, 'name'));
        const k = x.agents.find((y) => y.name === name);
        if (!k) throw new Refused(fail('agent_not_found', `No agent "${name}"`));
        k.name = to;
        return ok({ ...k });
      }).catch(refusedResult<LongAgent>);
      if (r.ok) await this.dropEmptyMailbox(name);
      return r;
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

  // projectLessons: the project's open lessons about the project, newest
  // first, for the start texts. A daemon that cannot list them leaves them
  // out; the launch itself reports a daemon that is down.
  private async projectLessons(slug: string): Promise<Lesson[]> {
    try {
      const list = await this.d.client.listLessons('new', { [LABEL.project]: slug, [LABEL.about]: 'project' });
      return [...list].sort((a, b) => b.id - a.id);
    } catch (err) {
      console.warn(`hopp: the lessons of ${slug} were not read for the start text: ${(err as Error).message}`);
      return [];
    }
  }

  // setLessonAbout sorts a lesson: about hopp, about a project, or unsorted.
  setLessonAbout(id: number, about: LessonAbout | null): Promise<Result<null>> {
    return guard(async () => {
      await this.d.client.setLessonLabels(id, { [LABEL.about]: about ?? '' });
      return ok(null);
    });
  }

  // setLessonProject names the project a lesson is about, or none.
  setLessonProject(id: number, slug: string | null): Promise<Result<null>> {
    return guard(async () => {
      if (slug !== null && !(await this.d.store.read()).projects.some((p) => p.slug === slug)) {
        return fail('project_not_found', `No project "${slug}"`);
      }
      await this.d.client.setLessonLabels(id, { [LABEL.project]: slug ?? '' });
      return ok(null);
    });
  }

  // lessonToGuardrails appends the lesson's text to its project's Guardrails
  // as one bullet that names the lesson, and closes the lesson. A lesson
  // already there is not added twice.
  lessonToGuardrails(id: number): Promise<Result<null>> {
    return guard(async () => {
      const lesson = (await this.d.client.listLessons('all')).find((l) => l.id === id);
      if (!lesson) return fail('lesson_not_found', `No lesson #${id}`);
      const slug = lesson.labels?.[LABEL.project] ?? '';
      if (!slug) return fail('lesson_no_project', `Lesson #${id} is not about a project; move it to one first`);
      const mark = `(lesson #${id})`;
      const bullet = '- ' + lesson.body.trim().replace(/\n+/g, '\n  ') + ' ' + mark;
      const r = await this.d.store
        .update((st) => {
          const p = st.projects.find((x) => x.slug === slug);
          if (!p) throw new Refused(fail('project_not_found', `Lesson #${id} is about "${slug}", which is not a project of the app`));
          if (!p.guardrails.includes(mark)) p.guardrails = p.guardrails.trimEnd() ? p.guardrails.trimEnd() + '\n' + bullet : bullet;
          return ok(null);
        })
        .catch(refusedResult<null>);
      if (!r.ok) return r;
      await this.d.client.closeLesson(id);
      return ok(null);
    });
  }

  async triageLessonsBrief(slug: string): Promise<string> {
    return triageBrief(slug);
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
    // Asks: the daemon does not copy a session's labels into its asks, so an
    // ask belongs to the task when it carries the task's label or comes from
    // one of the task's sessions (the orchestrator, or a session labelled
    // with the task).
    const [allAsks, sessions, stored] = await Promise.all([
      this.d.client.listAsks({ status: 'all' }),
      this.d.client.listSessions({ all: true }),
      this.d.client.listArtifacts({ scope: t.sessionId, versions: true }),
    ]);
    const mine = new Set([t.sessionId, ...sessions.filter((s) => s.labels?.[LABEL.task] === t.id).map((s) => s.id)]);
    const asks = allAsks.filter((a) => a.labels?.[LABEL.task] === t.id || mine.has(a.from));
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
      // The message is what matters: once it is sent, a failure to record the
      // post must not make the human send it again.
      try {
        return ok(await this.d.client.createPost({ from: '', body, labels }));
      } catch (err) {
        console.warn(`hopp: sent to ${t.sessionId} but could not record it in the feed: ${(err as Error).message}`);
        return ok({ id: 0, from: '', labels, body, attachments: [], created_at: this.now() });
      }
    });
  }

  // answerSubmission sends one of the ask's options, exactly as written;
  // the daemon refuses anything that is not one of them. A return option
  // needs the text of what to fix.
  answerSubmission(askId: number, answer: SubmissionAnswer): Promise<Result<Ask>> {
    return guard(async () => {
      const text = (answer.text ?? '').trim();
      if (submissionOptionKind(answer.choice) === 'return' && !text) return fail('text_required', 'Say what should be fixed', 'text');
      return ok(await this.d.client.answerAsk(askId, text ? { choice: answer.choice, answer: text } : { choice: answer.choice }));
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

  // ---- GitHub ------------------------------------------------------------------

  githubStatus(): Promise<GithubStatus> {
    return this.github.status();
  }

  listGithubRepos(query: string): Promise<Result<GithubRepo[]>> {
    return guard(() => this.github.list(query));
  }

  addGithubRepo(fullName: string): Promise<Result<{ path: string }>> {
    return guard(() => this.github.add(fullName));
  }

  // ---- model profiles ----------------------------------------------------------

  onProfilesChanged(cb: () => void): () => void {
    this.profileListeners.add(cb);
    return () => this.profileListeners.delete(cb);
  }

  private profilesChanged(): void {
    for (const cb of this.profileListeners) {
      try {
        cb();
      } catch {
        // a listener's failure is not ours
      }
    }
  }

  // A profile change: run it, tell listeners when it worked.
  private profileOp<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    return guard(async () => {
      const r = await fn();
      if (r.ok) this.profilesChanged();
      return r;
    });
  }

  setProfileEnabled(name: string, enabled: boolean): Promise<Result<ModelProfile>> {
    return this.profileOp(async () => {
      if (!enabled) {
        const { default: def } = await this.d.client.listModelProfiles();
        if (def === name) {
          return fail('profile_is_default', `${name} is the default profile; make another profile the default before switching it off`);
        }
      }
      return ok(await this.d.client.patchModelProfile(name, { enabled }));
    });
  }

  updateProfile(name: string, update: ProfileUpdate): Promise<Result<ModelProfile>> {
    return this.profileOp(async () => {
      const body: Partial<ModelProfile> = {};
      if (update.description !== undefined) body.description = update.description;
      if (update.model !== undefined) body.model = update.model;
      if (update.effort !== undefined) body.effort = update.effort;
      return ok(await this.d.client.patchModelProfile(name, body));
    });
  }

  setDefaultProfile(name: string): Promise<Result<null>> {
    return this.profileOp(async () => {
      await this.d.client.setDefaultProfile(name);
      return ok(null);
    });
  }

  removeProfile(name: string): Promise<Result<null>> {
    return this.profileOp(async () => {
      const sessions = (await this.d.client.listSessions()).filter((s) => s.profile === name && LIVE.has(s.state));
      const tasks = (await this.d.store.read()).tasks.filter(
        (t) => t.status === 'active' && (t.orchestratorProfile === name || t.workerProfiles.includes(name)),
      );
      if (sessions.length || tasks.length) {
        const what = [
          ...sessions.map((s) => `session ${s.id}`),
          ...tasks.map((t) => `task "${t.title}"`),
        ];
        return fail('profile_in_use', `${name} is in use by ${what.slice(0, 5).join(', ')}${what.length > 5 ? ` and ${what.length - 5} more` : ''}; finish or stop them first, or switch the profile off instead`);
      }
      await this.d.client.deleteModelProfile(name);
      return ok(null);
    });
  }

  moveProfile(name: string, position: number): Promise<Result<null>> {
    return this.profileOp(async () => {
      const { profiles } = await this.d.client.listModelProfiles();
      const order = [...profiles].sort((a, b) => a.position - b.position);
      const i = order.findIndex((p) => p.name === name);
      if (i < 0) return fail('profile_not_found', `No profile ${name}`);
      const [p] = order.splice(i, 1);
      order.splice(Math.max(0, Math.min(position, order.length)), 0, p!);
      for (const [k, x] of order.entries()) {
        if (x.position !== k) await this.d.client.patchModelProfile(x.name, { position: k });
      }
      return ok(null);
    });
  }

  modelCatalog(): Promise<Result<HarnessCatalog[]>> {
    return guard(async () => {
      const [raw, { profiles }] = await Promise.all([this.d.client.modelCatalog(), this.d.client.listModelProfiles()]);
      const used = new Set(profiles.map((p) => p.agent + '\u0000' + p.model));
      return ok(
        raw.map((c) => ({
          agent: c.agent, source: c.source ?? '', warning: c.warning ?? '',
          models: (c.models ?? []).map((m) => ({
            id: m.id, name: m.name ?? '', description: m.description ?? '', main: !!m.main, efforts: m.efforts ?? [],
            known: used.has(c.agent + '\u0000' + m.id),
          })),
        })),
      );
    });
  }

  // ---- models-add: a profile the human adds or copies ----

  addProfile(input: NewProfileInput): Promise<Result<ModelProfile>> {
    return this.profileOp(() => this.createProfile(input, null));
  }

  copyProfile(name: string, input: CopyProfileInput): Promise<Result<ModelProfile>> {
    return this.profileOp(async () => {
      const { profiles } = await this.d.client.listModelProfiles();
      const src = profiles.find((p) => p.name === name);
      if (!src) return fail('profile_not_found', `No profile ${name}`);
      const effort = input.effort ?? src.effort;
      return this.createProfile(
        { name: input.name, agent: src.agent, model: src.model, effort, description: input.description ?? src.description },
        src,
      );
    });
  }

  // createProfile checks input field by field, names it when it has no name
  // (the import naming, or the copy's), and creates it, on.
  private async createProfile(input: NewProfileInput, copyOf: ModelProfile | null): Promise<Result<ModelProfile>> {
    const agent = (input.agent ?? '').trim();
    if (!(HARNESSES as readonly string[]).includes(agent)) return fail('agent_unknown', `Choose one of: ${HARNESSES.join(', ')}`, 'agent');
    const model = (input.model ?? '').trim();
    if (!model) return fail('model_required', 'Name the model: one from the list or the id the harness takes', 'model');
    if (/\s/.test(model)) return fail('model_invalid', 'A model id has no spaces', 'model');
    const effort = (input.effort ?? '').trim();
    if (effort) {
      const listed = (await this.d.client.modelCatalog()).find((c) => c.agent === agent)?.models?.find((m) => m.id === model);
      const levels = listed ? (listed.efforts ?? []) : (HARNESS_EFFORTS[agent] ?? []);
      if (levels.length === 0) return fail('bad_effort', `${model} has no effort setting; leave it at default`, 'effort');
      if (!levels.includes(effort)) return fail('bad_effort', `Effort ${effort} is not one of ${listed ? model : agent}'s: ${levels.join(', ')}`, 'effort');
    }
    const { profiles } = await this.d.client.listModelProfiles();
    const taken = new Set(profiles.map((p) => p.name));
    let name = (input.name ?? '').trim();
    if (name) {
      if (!PROFILE_NAME_RE.test(name)) return fail('name_invalid', 'Use a-z, 0-9 and dashes, starting with a letter or digit, at most 40 characters', 'name');
      if (taken.has(name)) return fail('name_taken', `A profile named ${name} exists`, 'name');
    } else {
      name = copyOf ? copyProfileName(copyOf, effort, taken) : newProfileName(agent, model, effort, taken);
    }
    try {
      return ok(
        await this.d.client.createModelProfile({ name, agent, model, effort, description: (input.description ?? '').trim(), enabled: input.enabled ?? true }),
      );
    } catch (err) {
      if (err instanceof DaemonError) {
        const field = { profile_exists: 'name', bad_effort: 'effort', agent_unavailable: 'agent' }[err.code];
        if (field) return fail(err.code === 'profile_exists' ? 'name_taken' : err.code, err.message, field);
      }
      throw err;
    }
  }

  // Imports run one at a time: two at once would pick the same names.
  private imports: Promise<unknown> = Promise.resolve();

  importModels(): Promise<Result<ImportResult>> {
    const run = () => this.profileOp(() => this.importOnce());
    const p = this.imports.then(run, run);
    this.imports = p.catch(() => undefined);
    return p;
  }

  private async importOnce(): Promise<Result<ImportResult>> {
    const cat = await this.modelCatalog();
    if (!cat.ok) return cat;
    const { profiles } = await this.d.client.listModelProfiles();
    const taken = new Set(profiles.map((p) => p.name));
    const used = new Set(profiles.map((p) => p.agent + '\u0000' + p.model));
    const added: ModelProfile[] = [];
    const failed: { agent: string; reason: string }[] = [];
    let skipped = 0;
    for (const c of cat.value) {
      if (c.models.length === 0) {
        if (c.warning) failed.push({ agent: c.agent, reason: c.warning });
        continue;
      }
      for (const m of c.models) {
        if (!m.main || used.has(c.agent + '\u0000' + m.id)) {
          skipped++;
          continue;
        }
        const name = uniqueProfileName(importProfileName(c.agent, m.id), taken);
        if (!PROFILE_NAME_RE.test(name)) {
          skipped++;
          continue;
        }
        try {
          added.push(await this.d.client.createModelProfile({
            name, agent: c.agent, model: m.id, description: m.description || m.name, enabled: false,
          }));
          taken.add(name);
          used.add(c.agent + '\u0000' + m.id);
        } catch (err) {
          failed.push({ agent: c.agent, reason: `${m.id}: ${(err as Error).message}` });
        }
      }
    }
    return ok({ added, skipped, failed });
  }
}

// Refused carries a refusal out of a store update, so the update writes
// nothing and the caller still gets the Result.
// tmuxTaken: what the human reads when a live tmux session outside hopp
// holds the agent's name.
function tmuxTaken(name: string): string {
  return `A tmux session named ${name} already runs outside hopp. Choose another name, or close that session.`;
}

class Refused<T> extends Error {
  constructor(readonly result: Result<T>) {
    super('refused');
  }
}

function refusedResult<T>(err: unknown): Result<T> {
  if (err instanceof Refused) return err.result as Result<T>;
  throw err;
}
