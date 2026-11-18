// Shell IPC: every ShellBridge method on its own channel. Arguments from the
// page are checked here; a malformed call gets an error back (a Result error
// for methods that return a Result, a rejected promise for the others) and
// never throws in the main process.
import type { CopyProfileInput, LongAgentInput, NewProfileInput, PipelineInput, PipelineStageInput, ProfileUpdate, ProjectInput, Result, SubmissionAnswer, Task, TaskInput } from '../../shared/shell';
import { SHELL_CHANGED, SHELL_METHODS, SHELL_PROFILES_CHANGED, shellChannel, type ShellMethod } from '../../shared/ipc';
import { errorResult, type ShellService } from './service';

export class ArgError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, what: string, max = 100_000): string {
  if (typeof v !== 'string') throw new ArgError(`${what} must be text`);
  if (v.length > max) throw new ArgError(`${what} is too long`);
  return v;
}

function optStr(v: unknown, what: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, what);
}

function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > 100) throw new ArgError(`${what} must be a list of text`);
  return v.map((x, i) => str(x, `${what}[${i}]`, 4096));
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new ArgError(`${what} must be true or false`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ArgError(`${what} must be a whole number`);
  return v;
}

function projectInput(v: unknown): ProjectInput {
  if (!isObj(v)) throw new ArgError('project must be an object');
  const out: ProjectInput = {
    name: str(v['name'], 'name', 200),
    description: str(v['description'] ?? '', 'description'),
    orchestratorRepo: v['orchestratorRepo'] === null || v['orchestratorRepo'] === undefined ? null : str(v['orchestratorRepo'], 'orchestratorRepo', 4096),
    workerRepos: strList(v['workerRepos'] ?? [], 'workerRepos'),
    guardrails: str(v['guardrails'] ?? '', 'guardrails'),
  };
  const slug = optStr(v['slug'], 'slug');
  if (slug !== undefined) out.slug = slug;
  return out;
}

function taskInput(v: unknown): TaskInput {
  if (!isObj(v)) throw new ArgError('task must be an object');
  const out: TaskInput = {
    projectSlug: str(v['projectSlug'], 'projectSlug', 200),
    brief: str(v['brief'], 'brief'),
    orchestratorProfile: str(v['orchestratorProfile'], 'orchestratorProfile', 200),
    workerProfiles: strList(v['workerProfiles'] ?? [], 'workerProfiles'),
  };
  for (const k of ['title', 'sessionName', 'extraSystemPrompt', 'startedBy'] as const) {
    const x = optStr(v[k], k);
    if (x !== undefined) out[k] = x;
  }
  // pipelineId: a pipeline's id, or null for "No pipeline".
  if (v['pipelineId'] === null) out.pipelineId = null;
  else if (v['pipelineId'] !== undefined) out.pipelineId = str(v['pipelineId'], 'pipelineId', 200);
  return out;
}

function agentInput(v: unknown): LongAgentInput {
  if (!isObj(v)) throw new ArgError('agent must be an object');
  return { name: str(v['name'], 'name', 200), profile: str(v['profile'], 'profile', 200), dir: str(v['dir'], 'dir', 4096) };
}

function pipelineInput(v: unknown): PipelineInput {
  if (!isObj(v)) throw new ArgError('pipeline must be an object');
  if (!Array.isArray(v['stages']) || v['stages'].length > 100) throw new ArgError('stages must be a list');
  return {
    name: str(v['name'], 'name', 200),
    stages: v['stages'].map((x, i): PipelineStageInput => {
      if (!isObj(x)) throw new ArgError(`stages[${i}] must be an object`);
      const st: PipelineStageInput = {
        name: str(x['name'], `stages[${i}].name`, 200),
        does: str(x['does'] ?? '', `stages[${i}].does`),
        result: str(x['result'] ?? '', `stages[${i}].result`),
        substages: bool(x['substages'] ?? false, `stages[${i}].substages`),
        approval: bool(x['approval'] ?? false, `stages[${i}].approval`),
      };
      const id = optStr(x['id'], `stages[${i}].id`);
      if (id !== undefined) st.id = id;
      return st;
    }),
  };
}

function submissionAnswer(v: unknown): SubmissionAnswer {
  if (!isObj(v)) throw new ArgError('answer must be an object');
  const choice = str(v['choice'], 'choice', 4096);
  if (!choice.trim()) throw new ArgError('choice must be one of the ask\'s options');
  const out: SubmissionAnswer = { choice };
  const text = optStr(v['text'], 'text');
  if (text !== undefined) out.text = text;
  return out;
}

function profileUpdate(v: unknown): ProfileUpdate {
  if (!isObj(v)) throw new ArgError('update must be an object');
  const out: ProfileUpdate = {};
  for (const k of ['description', 'model', 'effort'] as const) {
    const x = optStr(v[k], k);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function lessonStatus(v: unknown): 'new' | 'closed' | 'all' {
  if (v === 'new' || v === 'closed' || v === 'all') return v;
  throw new ArgError('status must be new, closed or all');
}

function lessonAbout(v: unknown): 'hopp' | 'project' | null {
  if (v === 'hopp' || v === 'project' || v === null) return v;
  throw new ArgError('about must be hopp, project or null');
}

// optField: an optional string field of an object argument.
function optField(o: Record<string, unknown>, k: string, what: string, max = 10_000): string | undefined {
  return o[k] === undefined ? undefined : str(o[k], what, max);
}

function newProfileInput(v: unknown): NewProfileInput {
  if (!v || typeof v !== 'object') throw new ArgError('profile must be an object');
  const o = v as Record<string, unknown>;
  if (o['enabled'] !== undefined && typeof o['enabled'] !== 'boolean') throw new ArgError('enabled must be a boolean');
  return {
    name: optField(o, 'name', 'name', 200),
    agent: str(o['agent'], 'agent', 100),
    model: str(o['model'], 'model', 500),
    effort: optField(o, 'effort', 'effort', 100),
    description: optField(o, 'description', 'description') ?? '',
    enabled: o['enabled'] as boolean | undefined,
  };
}

function copyProfileInput(v: unknown): CopyProfileInput {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object') throw new ArgError('copy must be an object');
  const o = v as Record<string, unknown>;
  return { name: optField(o, 'name', 'name', 200), effort: optField(o, 'effort', 'effort', 100), description: optField(o, 'description', 'description') };
}

type Handler = (svc: ShellService, args: unknown[]) => Promise<unknown>;

// RESULT_METHODS answer a bad call with a Result error.
const handlers: Record<ShellMethod, { result: boolean; run: Handler }> = {
  state: { result: false, run: (s) => s.state() },
  createProject: { result: true, run: (s, a) => s.createProject(projectInput(a[0])) },
  updateProject: { result: true, run: (s, a) => s.updateProject(str(a[0], 'slug', 200), projectInput(a[1])) },
  removeProject: { result: true, run: (s, a) => s.removeProject(str(a[0], 'slug', 200)) },
  pickFolder: { result: false, run: (s) => s.pickFolder() },
  pickAttachments: { result: false, run: (s) => s.pickAttachments() },
  pasteAttachments: { result: false, run: (s) => s.pasteAttachments() },
  describePaths: { result: false, run: (s, a) => s.describePaths(strList(a[0], 'paths')) },
  openAttachment: { result: false, run: (s, a) => s.openAttachment(str(a[0], 'path', 4096), a[1] === true) },
  listProfiles: { result: false, run: (s) => s.listProfiles() },
  createTask: { result: true, run: (s, a) => s.createTask(taskInput(a[0])) },
  stopTask: { result: true, run: (s, a) => s.stopTask(str(a[0], 'task id', 200)) },
  resumeTask: { result: true, run: (s, a) => s.resumeTask(str(a[0], 'task id', 200)) },
  finishTask: { result: true, run: (s, a) => s.finishTask(str(a[0], 'task id', 200)) },
  hideTask: { result: true, run: (s, a) => s.hideTask(str(a[0], 'task id', 200)) },
  createAgent: { result: true, run: (s, a) => s.createAgent(agentInput(a[0])) },
  startAgent: { result: true, run: (s, a) => s.startAgent(str(a[0], 'agent name', 200)) },
  stopAgent: { result: true, run: (s, a) => s.stopAgent(str(a[0], 'agent name', 200)) },
  removeAgent: { result: true, run: (s, a) => s.removeAgent(str(a[0], 'agent name', 200)) },
  renameAgent: { result: true, run: (s, a) => s.renameAgent(str(a[0], 'agent name', 200), str(a[1], 'new name', 200)) },
  agentMail: { result: false, run: (s) => s.agentMail() },
  waiting: { result: false, run: (s) => s.waiting() },
  listTools: { result: false, run: (s) => s.listTools() },
  toolUsage: { result: false, run: (s, a) => s.toolUsage(str(a[0], 'tool name', 200)) },
  setToolEnabled: { result: true, run: (s, a) => s.setToolEnabled(str(a[0], 'tool name', 200), bool(a[1], 'enabled')) },
  toolRules: { result: false, run: (s) => s.toolRules() },
  setToolRules: { result: true, run: (s, a) => s.setToolRules(str(a[0], 'rules', 1_000_000)) },
  listLessons: { result: false, run: (s, a) => s.listLessons(lessonStatus(a[0])) },
  closeLesson: { result: true, run: (s, a) => s.closeLesson(int(a[0], 'lesson id')) },
  setLessonAbout: { result: true, run: (s, a) => s.setLessonAbout(int(a[0], 'lesson id'), lessonAbout(a[1])) },
  setLessonProject: { result: true, run: (s, a) => s.setLessonProject(int(a[0], 'lesson id'), a[1] === null ? null : str(a[1], 'project slug', 200)) },
  lessonToGuardrails: { result: true, run: (s, a) => s.lessonToGuardrails(int(a[0], 'lesson id')) },
  triageLessonsBrief: { result: false, run: (s, a) => s.triageLessonsBrief(str(a[0], 'project slug', 200)) },
  createPipeline: { result: true, run: (s, a) => s.createPipeline(pipelineInput(a[0])) },
  updatePipeline: { result: true, run: (s, a) => s.updatePipeline(str(a[0], 'pipeline id', 200), pipelineInput(a[1])) },
  removePipeline: { result: true, run: (s, a) => s.removePipeline(str(a[0], 'pipeline id', 200)) },
  taskFeed: { result: false, run: (s, a) => s.taskFeed(str(a[0], 'task id', 200)) },
  postToTask: {
    result: true,
    run: (s, a) => s.postToTask(str(a[0], 'task id', 200), str(a[1], 'text'), optStr(a[2], 'stage id')),
  },
  answerSubmission: { result: true, run: (s, a) => s.answerSubmission(int(a[0], 'ask id'), submissionAnswer(a[1])) },
  artifactText: { result: true, run: (s, a) => s.artifactText(int(a[0], 'artifact id')) },
  githubStatus: { result: false, run: (s) => s.githubStatus() },
  listGithubRepos: { result: true, run: (s, a) => s.listGithubRepos(str(a[0] ?? '', 'query', 200)) },
  addGithubRepo: { result: true, run: (s, a) => s.addGithubRepo(str(a[0], 'repository', 200)) },
  setProfileEnabled: { result: true, run: (s, a) => s.setProfileEnabled(str(a[0], 'profile', 200), bool(a[1], 'enabled')) },
  updateProfile: { result: true, run: (s, a) => s.updateProfile(str(a[0], 'profile', 200), profileUpdate(a[1])) },
  setDefaultProfile: { result: true, run: (s, a) => s.setDefaultProfile(str(a[0], 'profile', 200)) },
  removeProfile: { result: true, run: (s, a) => s.removeProfile(str(a[0], 'profile', 200)) },
  moveProfile: { result: true, run: (s, a) => s.moveProfile(str(a[0], 'profile', 200), int(a[1], 'position')) },
  modelCatalog: { result: true, run: (s) => s.modelCatalog() },
  importModels: { result: true, run: (s) => s.importModels() },
  addProfile: { result: true, run: (s, a) => s.addProfile(newProfileInput(a[0])) },
  copyProfile: { result: true, run: (s, a) => s.copyProfile(str(a[0], 'profile name', 200), copyProfileInput(a[1])) },
};

// callShell runs one method with arguments from the page.
export async function callShell(svc: ShellService, method: string, args: unknown[]): Promise<unknown> {
  const h = (handlers as Record<string, (typeof handlers)[ShellMethod] | undefined>)[method];
  if (!h || !Object.prototype.hasOwnProperty.call(handlers, method)) throw new ArgError('unknown shell method: ' + method);
  try {
    return await h.run(svc, args);
  } catch (err) {
    if (!h.result) throw err instanceof Error ? err : new Error(String(err));
    if (err instanceof ArgError) return { ok: false, error: { code: 'bad_request', message: err.message } } satisfies Result<never>;
    return errorResult(err);
  }
}

// createTaskSaying is createTask as callShell runs it, with say hearing the
// launch's steps.
export async function createTaskSaying(svc: ShellService, args: unknown[], say: (line: string) => void): Promise<Result<Task>> {
  try {
    return await svc.createTask(taskInput(args[0]), say);
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, error: { code: 'bad_request', message: err.message } };
    return errorResult(err);
  }
}

export interface IpcMainLike {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void;
}

// registerShellIpc wires every method and forwards store changes with send.
export function registerShellIpc(ipc: IpcMainLike, svc: ShellService, send: (channel: string, ...args: unknown[]) => void): void {
  for (const m of SHELL_METHODS) ipc.handle(shellChannel(m), (_e, ...args) => callShell(svc, m, args));
  svc.onChanged((s) => send(SHELL_CHANGED, s));
  svc.onProfilesChanged(() => send(SHELL_PROFILES_CHANGED));
}
