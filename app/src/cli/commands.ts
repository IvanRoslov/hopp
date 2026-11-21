// The commands `hopp project`, `hopp pipeline` and `hopp task`: what an agent
// (or the human in a terminal) can do with the app's projects, pipelines and
// tasks. Projects and pipelines are only read here; the human edits them in
// the app.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { deriveStages } from '../shared/stages';
import type { ModelProfile, Pipeline, Project, Result, ShellState, Task, TaskInput } from '../shared/shell';
import type { Ask, Session } from '../shared/types';
import { DaemonUnavailable } from '../main/daemon/client';
import { AppError, type ShellApi } from './connect';

// Exit codes, as the hopp CLI's: 1 an error, 2 the daemon is not running,
// 3 a usage error.
export const EXIT = { ok: 0, error: 1, daemon: 2, usage: 3 } as const;

export class UsageError extends Error {}
class Failed extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.error,
  ) {
    super(message);
  }
}

// What the commands need from the outside world; tests pass their own.
export interface CliContext {
  // The shell API: the app's, or this process's own.
  shell: () => Promise<ShellApi>;
  // Daemon reads: sessions and their states.
  sessions: () => Promise<Session[]>;
  getSession: (id: string) => Promise<Session | null>;
  env: Record<string, string | undefined>;
  // The text on stdin, or null when stdin is a terminal.
  stdin: () => Promise<string | null>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export const USAGE: Record<string, string> = {
  project: [
    'Usage: hopp project ls [--json]',
    '       hopp project show <project> [--json]',
    '',
    'The projects of the hopp app. Create and edit them in the app.',
  ].join('\n'),
  pipeline: [
    'Usage: hopp pipeline ls [--json]',
    '       hopp pipeline show <id or name> [--json]',
    '',
    'The pipelines of the hopp app: the stages a task goes through. Create and edit them in the app.',
  ].join('\n'),
  task: [
    'Usage: hopp task ls [--project <project>] [--all] [--json]',
    '       hopp task show <task> [--json]',
    '       hopp task feed <task> [--json]',
    '       hopp task new --project <project> (--brief "<text>" | --file <path> | stdin)',
    '                     [--title <title>] [--orchestrator <profile>] [--worker <profile>]...',
    '                     [--pipeline <id or name>] [--json]',
    '       hopp task stop|resume|finish <task> [--json]',
    '       hopp task add-worker <task> --worker <profile>... [--json]',
    '',
    'Tasks of the hopp app. `task new` starts an orchestrator in the project; run inside a hopp',
    'session, the task reports to that session ($HOPP_SESSION_ID). Defaults: the orchestrator runs',
    'the daemon\'s default profile; workers use the profiles of the project\'s last task, or the',
    'orchestrator\'s profile. `task add-worker` allows more worker profiles in a task that is not',
    'finished and tells its orchestrator.',
  ].join('\n'),
};

function fmtTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? '')].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - [...c].length))).join('  ').trimEnd()).join('\n');
}

const oneLine = (s: string, max = 80) => {
  const l = s.replace(/\s+/g, ' ').trim();
  return [...l].length > max ? [...l].slice(0, max - 1).join('') + '…' : l;
};

function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new Failed(r.error.message, r.error.code === 'daemon_unavailable' ? EXIT.daemon : EXIT.error);
}

function findProject(st: ShellState, slug: string): Project {
  const p = st.projects.find((x) => x.slug === slug);
  if (p) return p;
  const known = st.projects.map((x) => x.slug).join(', ') || 'none yet; the human creates them in the app';
  throw new Failed(`no project "${slug}". Projects: ${known}`);
}

function findPipeline(st: ShellState, key: string): Pipeline {
  const k = key.trim().toLowerCase();
  const p = st.pipelines.find((x) => x.id === key) ?? st.pipelines.find((x) => x.name.toLowerCase() === k);
  if (p) return p;
  const known = st.pipelines.map((x) => `${x.id} ("${x.name}")`).join(', ') || 'none';
  throw new Failed(`no pipeline "${key}". Pipelines: ${known}`);
}

function findTask(st: ShellState, id: string): Task {
  const t = st.tasks.find((x) => x.id === id);
  if (t) return t;
  throw new Failed(`no task "${id}"; \`hopp task ls --all\` lists them`);
}

// taskState: what a task is doing, from its status and its session.
function taskState(t: Task, sessions: Map<string, Session>): string {
  if (t.status === 'finished') return 'finished';
  const s = sessions.get(t.sessionId);
  if (!s) return 'session gone';
  return s.state;
}

function stagesLine(t: Task, posts: Parameters<typeof deriveStages>[1], asks: Ask[]): { line: string; states: ReturnType<typeof deriveStages> } | null {
  if (!t.pipeline) return null;
  const states = deriveStages(t.pipeline, posts, asks);
  const n = t.pipeline.stages.length;
  // The stage in focus: the last one that has started.
  let i = -1;
  states.forEach((s, k) => {
    if (s.status !== 'not_started') i = k;
  });
  if (i < 0) return { line: `${t.pipeline.name}: not started (${n} stages)`, states };
  const st = states[i]!;
  return { line: `${t.pipeline.name}: stage ${i + 1} of ${n} "${t.pipeline.stages[i]!.name}", ${st.status.replace('_', ' ')}`, states };
}

// ---- project ----------------------------------------------------------------

async function projectCmd(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {});
  const [sub, slug, ...rest] = positionals;
  const st = await (await ctx.shell()).state();
  if (sub === 'ls' && !slug) {
    if (values.json) return ctx.out(JSON.stringify(st.projects, null, 2));
    if (st.projects.length === 0) return ctx.out('No projects yet. The human creates them in the hopp app.');
    const active = (p: Project) => st.tasks.filter((t) => t.projectSlug === p.slug && t.status === 'active' && !t.hidden).length;
    return ctx.out(table([['PROJECT', 'NAME', 'WHERE', 'ACTIVE TASKS'], ...st.projects.map((p) => [p.slug, p.name, p.orchestratorRepo ?? '(a folder per task)', String(active(p))])]));
  }
  if (sub === 'show' && slug && rest.length === 0) {
    const p = findProject(st, slug);
    const tasks = st.tasks.filter((t) => t.projectSlug === p.slug && t.status === 'active' && !t.hidden);
    if (values.json) return ctx.out(JSON.stringify({ ...p, activeTasks: tasks.map((t) => t.id) }, null, 2));
    const lines = [
      `${p.slug} — ${p.name}`,
      p.description ? '\n' + p.description + '\n' : '',
      `repository:   ${p.orchestratorRepo ?? '(none: each task gets its own folder)'}`,
    ];
    if (p.workerRepos.length) lines.push(`worker repos: ${p.workerRepos.join(', ')}`);
    lines.push(`active tasks: ${tasks.map((t) => t.id).join(', ') || 'none'}`);
    if (p.guardrails.trim()) lines.push('', 'Rules every orchestrator of this project gets:', p.guardrails.trim());
    return ctx.out(lines.filter((l) => l !== '').join('\n'));
  }
  throw new UsageError(USAGE['project']!);
}

// ---- pipeline ---------------------------------------------------------------

async function pipelineCmd(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {});
  const [sub, ...rest] = positionals;
  const st = await (await ctx.shell()).state();
  if (sub === 'ls' && rest.length === 0) {
    if (values.json) return ctx.out(JSON.stringify(st.pipelines, null, 2));
    if (st.pipelines.length === 0) return ctx.out('No pipelines. The human creates them in the hopp app.');
    return ctx.out(table([['PIPELINE', 'NAME', 'STAGES'], ...st.pipelines.map((p) => [p.id, p.name, p.stages.map((s) => s.name).join(' → ')])]));
  }
  if (sub === 'show' && rest.length > 0) {
    const p = findPipeline(st, rest.join(' '));
    if (values.json) return ctx.out(JSON.stringify(p, null, 2));
    const lines = [`${p.id} — ${p.name}`, ''];
    p.stages.forEach((s, i) => {
      const flags = [s.approval ? 'waits for the human\'s approval' : 'no approval', s.substages ? 'substages' : ''].filter(Boolean).join(', ');
      lines.push(`${i + 1}. ${s.name} (${s.id}; ${flags})`);
      if (s.does) lines.push(`   does: ${s.does}`);
      if (s.result) lines.push(`   result: ${s.result}`);
    });
    return ctx.out(lines.join('\n'));
  }
  throw new UsageError(USAGE['pipeline']!);
}

// ---- task -------------------------------------------------------------------

async function sessionMap(ctx: CliContext): Promise<Map<string, Session>> {
  return new Map((await ctx.sessions()).map((s) => [s.id, s]));
}

async function taskLs(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { project: { type: 'string' }, all: { type: 'boolean' } });
  if (positionals.length) throw new UsageError(USAGE['task']!);
  const st = await (await ctx.shell()).state();
  if (values.project) findProject(st, values.project as string);
  const tasks = st.tasks
    .filter((t) => !values.project || t.projectSlug === values.project)
    .filter((t) => values.all || (t.status === 'active' && !t.hidden))
    .sort((a, b) => b.createdAt - a.createdAt);
  const sessions = await sessionMap(ctx);
  if (values.json) return ctx.out(JSON.stringify(tasks.map((t) => ({ ...t, state: taskState(t, sessions) })), null, 2));
  if (tasks.length === 0) return ctx.out(values.all ? 'No tasks.' : 'No active tasks. `hopp task ls --all` lists finished ones too.');
  return ctx.out(table([['TASK', 'PROJECT', 'STATE', 'STARTED', 'TITLE'], ...tasks.map((t) => [t.id, t.projectSlug, taskState(t, sessions) + (t.hidden ? ' (hidden)' : ''), fmtTime(t.createdAt), oneLine(t.title, 60)])]));
}

async function taskShow(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError(USAGE['task']!);
  const api = await ctx.shell();
  const t = findTask(await api.state(), positionals[0]!);
  const [all, feed] = await Promise.all([ctx.sessions(), api.taskFeed(t.id)]);
  const sessions = new Map(all.map((s) => [s.id, s]));
  const mine = all.filter((s) => s.id === t.sessionId || s.labels?.['hopp.task'] === t.id);
  const openAsks = feed.asks.filter((a) => a.status === 'open');
  const stages = stagesLine(t, feed.posts, feed.asks);
  if (values.json) {
    return ctx.out(JSON.stringify({
      task: t,
      state: taskState(t, sessions),
      sessions: mine.map((s) => ({ id: s.id, state: s.state, profile: s.profile, role: s.labels?.['hopp.role'] ?? '' })),
      openAsks,
      stages: stages?.states.map((s) => ({ stageId: s.stageId, status: s.status })) ?? null,
    }, null, 2));
  }
  const b = t.base;
  const lines = [
    `${t.id} — ${t.title}`,
    `project:      ${t.projectSlug}`,
    `state:        ${taskState(t, sessions)}${t.status === 'finished' ? ` (${fmtTime(t.finishedAt)})` : ''}`,
    `orchestrator: ${t.sessionId} (profile ${t.orchestratorProfile})`,
    `workers:      ${t.workerProfiles.join(', ')}`,
    `pipeline:     ${stages ? stages.line : 'none'}`,
    `branch:       ${t.branch ?? 'none (a plain folder)'}`,
    `folder:       ${t.dir}`,
    `started from: ${b ? `${b.ref} at ${b.commit.slice(0, 12)} (${fmtTime(b.committedAt)})${b.warning ? ' — ' + b.warning : ''}` : '-'}`,
    `started by:   ${t.startedBy ? `${t.startedBy} (an agent)` : 'the human'}, ${fmtTime(t.createdAt)}`,
    `sessions:     ${mine.map((s) => `${s.id} (${s.state})`).join(', ') || 'none'}`,
  ];
  if (openAsks.length === 0) lines.push('open asks:    none');
  else {
    lines.push('open asks:');
    for (const a of openAsks) lines.push(`  #${a.id} from ${a.from}: ${oneLine(a.body)}${a.options?.length ? ` [${a.options.join(' / ')}]` : ''}`);
  }
  ctx.out(lines.join('\n'));
}

async function taskFeedCmd(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError(USAGE['task']!);
  const api = await ctx.shell();
  const t = findTask(await api.state(), positionals[0]!);
  const feed = await api.taskFeed(t.id);
  if (values.json) return ctx.out(JSON.stringify(feed, null, 2));
  const stage = (l: Record<string, string> | null) => (l?.['hopp.stage'] ? ` [${l['hopp.stage']}]` : '');
  const items: { ts: number; id: number; text: string }[] = [
    ...feed.posts.map((p) => ({ ts: p.created_at, id: p.id, text: `post   ${p.from || 'the human'}${stage(p.labels)}: ${p.body.trim()}` })),
    ...feed.asks.map((a) => {
      const ans = a.status === 'answered' ? ` → ${[a.choice, a.answer].filter(Boolean).join(': ')}` : a.status === 'open' ? ' (open)' : ` (${a.status})`;
      return { ts: a.created_at, id: a.id, text: `ask #${a.id} ${a.from}${stage(a.labels)}: ${a.body.trim()}${ans}` };
    }),
    ...feed.artifacts.map((a) => ({ ts: a.created_at, id: a.id, text: `artifact ${a.name}@${a.version} (${a.filename}) from ${a.from}${stage(a.labels)}` })),
  ].sort((x, y) => x.ts - y.ts || x.id - y.id);
  if (items.length === 0) return ctx.out('The feed is empty.');
  ctx.out(items.map((i) => `${fmtTime(i.ts)}  ${i.text}`).join('\n'));
}

async function readBrief(ctx: CliContext, v: { brief?: unknown; file?: unknown }): Promise<string> {
  if (v.brief !== undefined && v.file !== undefined) throw new UsageError('give the brief with --brief or --file, not both');
  if (typeof v.brief === 'string') return v.brief;
  if (typeof v.file === 'string') {
    if (v.file === '-') return (await ctx.stdin()) ?? '';
    try {
      return await readFile(v.file, 'utf8');
    } catch (err) {
      throw new Failed(`cannot read ${v.file}: ${(err as Error).message}`);
    }
  }
  const s = await ctx.stdin();
  if (s === null) throw new UsageError('say what needs to be done: --brief "<text>", --file <path>, or the brief on stdin');
  return s;
}

// defaultWorkers: the worker profiles of the project's most recent task,
// when all of them are still enabled; else none (the service then uses the
// orchestrator's profile).
function defaultWorkers(st: ShellState, project: string, enabled: Set<string>): string[] {
  // The newest; of two in the same second, the one stored later.
  const last = st.tasks.filter((t) => t.projectSlug === project).reduce<Task | undefined>((a, b) => (!a || b.createdAt >= a.createdAt ? b : a), undefined);
  if (last && last.workerProfiles.length > 0 && last.workerProfiles.every((w) => enabled.has(w))) return last.workerProfiles;
  return [];
}

async function taskNew(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    project: { type: 'string' }, brief: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' },
    orchestrator: { type: 'string' }, worker: { type: 'string', multiple: true }, pipeline: { type: 'string' },
  });
  if (positionals.length) throw new UsageError(`unexpected "${positionals[0]}"; quote the brief: --brief "<text>"`);
  if (!values.project) throw new UsageError('--project is required; `hopp project ls` lists the projects');
  const starter = (ctx.env['HOPP_SESSION_ID'] ?? '').trim();
  if (starter) {
    // The service refuses this too; saying it here spares the launch work.
    const s = await ctx.getSession(starter);
    const role = s?.labels?.['hopp.role'];
    if (role === 'orchestrator' || role === 'worker') {
      throw new Failed(`${starter} is ${role === 'orchestrator' ? 'an orchestrator' : 'a worker'} of a task, and tasks are not started from inside tasks. Ask your orchestrator or the human instead.`);
    }
  }
  const brief = (await readBrief(ctx, values)).trim();
  if (!brief) throw new UsageError('the brief is empty');
  const api = await ctx.shell();
  const st = await api.state();
  const project = findProject(st, values.project as string);
  const pipeline = values.pipeline ? findPipeline(st, values.pipeline as string) : null;
  const profiles = await api.listProfiles();
  const enabled = profiles.filter((p) => p.enabled);
  const names = new Set(enabled.map((p) => p.name));
  const known = enabled.map((p) => p.name).join(', ') || 'none';
  const check = (name: string, what: string) => {
    if (!names.has(name)) throw new Failed(`${what} "${name}" is not an enabled profile. Enabled: ${known}`);
  };
  let orch = values.orchestrator as string | undefined;
  let orchWhy = 'given';
  if (orch) check(orch, '--orchestrator');
  else {
    const def: ModelProfile | undefined = enabled.find((p) => p.isDefault) ?? enabled[0];
    if (!def) throw new Failed('the daemon has no enabled model profile; the human enables one in the app (Models)');
    orch = def.name;
    orchWhy = def.isDefault ? "the daemon's default" : 'the first enabled profile; the daemon has no default';
  }
  let workers = (values.worker as string[] | undefined) ?? [];
  let workersWhy = 'given';
  if (workers.length) workers.forEach((w) => check(w, '--worker'));
  else {
    workers = defaultWorkers(st, project.slug, names);
    workersWhy = workers.length ? "as the project's last task" : "the orchestrator's profile";
    if (!workers.length) workers = [orch];
  }
  const input: TaskInput = { projectSlug: project.slug, brief, orchestratorProfile: orch, workerProfiles: workers, pipelineId: pipeline?.id ?? null };
  if (typeof values.title === 'string' && values.title.trim()) input.title = values.title;
  if (starter) input.startedBy = starter;
  // The launch's steps go to stderr, so --json output stays one document.
  const task = unwrap(await api.createTask(input, (line) => ctx.err('hopp: ' + line)));
  if (values.json) {
    return ctx.out(JSON.stringify({ task: task.id, orchestrator: task.sessionId, orchestratorProfile: orch, workerProfiles: workers, pipeline: pipeline?.id ?? null, startedBy: task.startedBy, dir: task.dir, branch: task.branch }, null, 2));
  }
  const lines = [
    `task:         ${task.id}`,
    `orchestrator: ${task.sessionId}`,
    `profile:      ${orch} (${orchWhy})`,
    `workers:      ${workers.join(', ')} (${workersWhy})`,
    `pipeline:     ${pipeline ? `${pipeline.name} (${pipeline.id})` : 'none'}`,
    `folder:       ${task.dir}${task.branch ? ` (branch ${task.branch})` : ''}`,
    '',
  ];
  if (task.startedBy) {
    lines.push(
      `The task reports to you (${task.startedBy}): its orchestrator sends you its questions about the request and its progress reports as messages.`,
      `Write to it:  hopp send ${task.sessionId} "<text>"`,
      'Decisions that belong to the human and stage approvals still go to the human, in the app.',
    );
  } else {
    lines.push(`Write to the orchestrator: hopp send ${task.sessionId} "<text>"`);
  }
  lines.push(`Follow it:    hopp task show ${task.id}`);
  ctx.out(lines.join('\n'));
}

async function taskChange(ctx: CliContext, verb: 'stop' | 'resume' | 'finish', args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError(USAGE['task']!);
  const api = await ctx.shell();
  const t = findTask(await api.state(), positionals[0]!);
  const fn = verb === 'stop' ? api.stopTask : verb === 'resume' ? api.resumeTask : api.finishTask;
  unwrap(await fn.call(api, t.id));
  if (values.json) return ctx.out(JSON.stringify({ task: t.id, done: verb }));
  ctx.out({ stop: `stopped ${t.id}; \`hopp task resume ${t.id}\` continues it`, resume: `resumed ${t.id}`, finish: `finished ${t.id}` }[verb]);
}

// taskAddWorker: more worker profiles for a task; prints the ones that were new.
async function taskAddWorker(ctx: CliContext, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { worker: { type: 'string', multiple: true } });
  if (positionals.length !== 1) throw new UsageError(USAGE['task']!);
  const workers = (values.worker as string[] | undefined) ?? [];
  if (!workers.length) throw new UsageError('--worker <profile> is required, once per profile; `hopp task show` lists the task\'s workers');
  const api = await ctx.shell();
  const t = findTask(await api.state(), positionals[0]!);
  const after = unwrap(await api.addTaskWorkers(t.id, workers));
  const added = after.workerProfiles.filter((w) => !t.workerProfiles.includes(w));
  if (values.json) return ctx.out(JSON.stringify({ task: t.id, added, workerProfiles: after.workerProfiles }));
  ctx.out(added.length ? `added to ${t.id}: ${added.join(', ')}` : `${t.id} already has: ${[...new Set(workers)].join(', ')}`);
}

async function taskCmd(ctx: CliContext, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'ls':
      return taskLs(ctx, rest);
    case 'show':
      return taskShow(ctx, rest);
    case 'feed':
      return taskFeedCmd(ctx, rest);
    case 'new':
      return taskNew(ctx, rest);
    case 'stop':
    case 'resume':
    case 'finish':
      return taskChange(ctx, sub, rest);
    case 'add-worker':
      return taskAddWorker(ctx, rest);
    default:
      throw new UsageError(USAGE['task']!);
  }
}

// ---- shared -----------------------------------------------------------------

type Opts = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

function parse(args: string[], options: Opts): { values: Values; positionals: string[] } {
  try {
    return parseArgs({ args, options: { ...options, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

// runCli runs `hopp <noun> <args…>` and returns the exit code.
export async function runCli(noun: string, args: string[], ctx: CliContext): Promise<number> {
  const usage = USAGE[noun];
  if (!usage) {
    ctx.err(`hopp: unknown command "${noun}"`);
    return EXIT.usage;
  }
  if (args.length === 0) {
    ctx.err(usage);
    return EXIT.usage;
  }
  if (args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    ctx.out(usage);
    return EXIT.ok;
  }
  try {
    if (noun === 'project') await projectCmd(ctx, args);
    else if (noun === 'pipeline') await pipelineCmd(ctx, args);
    else await taskCmd(ctx, args);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(`hopp ${noun}: ${err.message}`);
      return EXIT.usage;
    }
    if (err instanceof Failed) {
      ctx.err(`hopp ${noun}: ${err.message}`);
      return err.code;
    }
    const e = err as Error;
    if (err instanceof DaemonUnavailable) {
      ctx.err(`hopp ${noun}: the hopp daemon is not running; start it with \`hopp daemon start\``);
      return EXIT.daemon;
    }
    ctx.err(`hopp ${noun}: ${err instanceof AppError ? err.message : (e?.message ?? String(err))}`);
    return EXIT.error;
  }
}
