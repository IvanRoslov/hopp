// Start texts: what each session is told when it starts. Pure functions, built
// in layers: (1) hopp, (2) role, (3) project, (4) tools, then the human's
// extra system prompt. A long-lived agent gets layers 1 and 4 only; its role
// lives in its own folder.
import type { Lesson, Pipeline, Project, TaskBase } from '../../shared/shell';
import { LABEL } from '../../shared/shell';

// hoppLayer: you run inside hopp, and the commands every session uses.
export function hoppLayer(): string {
  return [
    '# You run inside hopp',
    '',
    'hopp runs AI agents in tmux sessions and carries messages between them. Your session id is in $HOPP_SESSION_ID; the session that launched you, if any, is in $HOPP_PARENT_ID. Use the `hopp` command:',
    '',
    '- `hopp send <session> "<text>"` sends a message to another session; for multi-line or markdown text write it to a file first and use `hopp send <session> --file <path>` (`--file -` reads stdin only when something is piped in; an empty text is refused, never sent). Messages to you arrive in your input.',
    '- `hopp ls --mine` lists the sessions you launched; `hopp ls` lists every running session.',
    '- `hopp ask "<question>" [--option <choice>]... [--wait]` asks the human; the answer comes back as a message (and as the output of `--wait`). Offer options only when they cover the cases: the human may answer in their own words instead. When the human settles your question some other way (a message, a line in the feed), withdraw the ask with `hopp ask withdraw <id>` so it does not stay waiting; an ask the human dismisses as not relevant gets no answer, so go by what was said since.',
    '- `hopp lesson` records what cost you time, so the next agent does not lose it again. Two kinds:',
    '  - `hopp lesson --label hopp.about=project "<what the next agent in this project must know>"`: a fact about the project\'s repository, its tools or environments.',
    '  - `hopp lesson --label hopp.about=hopp "<what in hopp got in the way or is missing>"`: its commands, start texts, pipelines, tools or the app.',
    '  One lesson is one fact, written so that someone without your context can act on it: say what you ran and what fixed it. Outside a project, use hopp.about=hopp, or name the project in the text.',
    '- `hopp tools list`, `hopp tools show <name>` and `hopp tools rules` describe the tools you may use.',
  ].join('\n');
}

export interface WorkerFile {
  // A model profile the human allowed for workers.
  profile: string;
  // The harness that profile runs (the profile's agent).
  harness: string;
  // The start-text file for workers of that harness.
  file: string;
}

export interface OrchestratorContext {
  project: Project;
  taskId: string;
  title: string;
  // The task's own folder (the orchestrator's working folder).
  taskDir: string;
  // Where worker folders go: <HOPP_HOME>/worktrees/<project>.
  worktreesDir: string;
  workers: WorkerFile[];
  toolsPrompt: string;
  extraSystemPrompt?: string;
  // The human's request. It is also the first message; the text repeats it
  // because a resumed session starts with this text and no conversation.
  brief?: string;
  // The task's pipeline; null or absent for a task without one.
  pipeline?: Pipeline | null;
  // What the task's worktree started from; absent for a plain folder.
  base?: TaskBase | null;
  // Managed clones (from GitHub) and the ref their worktrees start from,
  // e.g. origin/main; plain repositories are absent.
  repoBases?: Record<string, string>;
  // The agent session that started the task; absent when the human did.
  startedBy?: string | null;
  // The project's open lessons (hopp.about=project), newest first.
  lessons?: Lesson[];
}

export interface WorkerContext {
  project: Project;
  taskId: string;
  title: string;
  toolsPrompt: string;
  // The project's open lessons (hopp.about=project), newest first.
  lessons?: Lesson[];
}

export interface AgentContext {
  toolsPrompt: string;
}

// allowedRepos: where workers may run. The orchestrator's repository always,
// plus the worker repositories.
export function allowedRepos(p: Project): string[] {
  const out: string[] = [];
  if (p.orchestratorRepo) out.push(p.orchestratorRepo);
  for (const r of p.workerRepos) if (!out.includes(r)) out.push(r);
  return out;
}

function projectLayer(p: Project, forOrchestrator: boolean, worktreesDir?: string, repoBases: Record<string, string> = {}): string {
  const lines = ['# Project: ' + p.name, ''];
  if (p.description) lines.push(p.description, '');
  if (forOrchestrator) {
    const repos = allowedRepos(p);
    if (repos.length > 0) {
      lines.push('Workers may run only in worktrees of these repositories, made under ' + worktreesDir + ':', '');
      for (const r of repos) {
        const b = repoBases[r];
        lines.push(b ? `- ${r} — a clone of a GitHub repository; base worker worktrees on \`${b}\`, after \`git -C ${r} fetch origin\`` : '- ' + r);
      }
    } else {
      lines.push('This project has no repository. Workers run in plain folders under ' + worktreesDir + '.');
    }
    lines.push('', 'hopp refuses to launch a session outside these folders.', '');
  }
  if (p.guardrails) lines.push('## Guardrails', '', p.guardrails, '');
  return lines.join('\n').trimEnd();
}

function toolsLayer(toolsPrompt: string): string {
  const t = toolsPrompt.trim();
  if (t) return t;
  return [
    '## Tools',
    '',
    'The tool catalog has no tools for you yet. If you need one, ask the human with `hopp ask` instead of improvising, and record it with `hopp lesson`.',
  ].join('\n');
}

const join = (parts: (string | undefined)[]) =>
  parts
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join('\n\n') + '\n';

export function orchestratorText(c: OrchestratorContext): string {
  const repos = allowedRepos(c.project);
  const name = '<name>';
  const dir = `${c.worktreesDir}/${c.taskId}-${name}`;
  const anyBase = Object.keys(c.repoBases ?? {}).length > 0;
  const prepare =
    repos.length > 0
      ? [
          `   git -C <repository> worktree add -b hopp/${c.taskId}-${name} ${dir}` + (anyBase ? ' [<base>]' : ''),
          '',
          '   where <repository> is one of the repositories listed under the project' +
            (c.project.workerRepos.length === 0 ? ' (the orchestrator\'s repository).' : '.') +
            (anyBase ? ' For a repository listed with a base, fetch it first and put that base at the end; for the others, leave it out.' : ''),
        ]
      : [`   mkdir -p ${dir}`];
  const profiles = c.workers.map((w) => `   - \`${w.profile}\` (${w.harness}): \`--system-prompt-file ${w.file}\``);
  const role = [
    '# Your role: orchestrator',
    '',
    `You lead the task "${c.title}" (task id \`${c.taskId}\`). Your folder is ${c.taskDir}. The human's request is your first message.`,
    ...baseLines(c.base),
    ...startedByLines(c.startedBy),
    '',
    'Plan the work, split it into pieces, and launch workers for the pieces. You own the result: review what workers return and integrate it.',
    '',
    '## Launching a worker',
    '',
    `1. Make the worker's folder. Pick a short ${name} (a-z, 0-9, dashes):`,
    '',
    ...prepare,
    '',
    '2. Launch the worker in it with one of the worker profiles the human allowed, and the start-text file for that profile:',
    '',
    ...profiles,
    '',
    `   hopp run ${dir} --name ${c.taskId}-${name} --profile <profile> --label hopp.role=worker --system-prompt-file <file> -m "<what the worker must do>"`,
    '',
    '   Use only these profiles; the model of a session cannot change after launch. The worker inherits this task\'s labels and folder limits.',
    '',
    '3. A worker\'s report arrives in your input as a message, like the human\'s request did. Go on with your own part meanwhile, or wait; do not poll its folder, `git log` or `hopp ls` for it. `hopp ls --mine` shows your workers when you need their state.',
    '',
    '4. Once a worker\'s piece is reviewed and in your branch, stop it with `hopp kill <worker session>`; its folder and branch stay.',
    '',
    '## The human',
    '',
    'Ask the human with `hopp ask` when a decision is theirs. Workers never ask the human: they ask you. If the human answers an open ask of yours by writing to you instead, withdraw that ask (`hopp ask withdraw <id>`) once you have what you need.',
    '',
    'Write to the human (asks, posts, lessons) in the language of the task\'s brief, whatever language you otherwise use.',
    '',
    c.pipeline
      ? 'The task follows a pipeline (below): the human accepts it stage by stage in the feed. When the last stage is accepted, post a short summary of the whole task to the feed.'
      : 'When the work is ready, say so with `hopp ask "Ready for review: <what is done and where, in one line>" --option Accept --option Revise` and wait for the answer. On Revise, continue with what the human asked for.',
    '',
    'Record anything that would have made this task go better with `hopp lesson`.',
    '',
    '## After a restart',
    '',
    'When the human resumes a stopped task you start again with this text and an empty conversation. Before doing anything, find where the work stands: your branch (`git log`, `git status`), your workers (`hopp ls --mine`) and what was said (`hopp messages $HOPP_SESSION_ID`). Then continue from there; do not redo what is done.',
  ].join('\n');
  const brief = (c.brief ?? '').trim();
  const task = brief ? '## The task\n\n' + brief : undefined;
  return join([
    hoppLayer(),
    role,
    task,
    projectLayer(c.project, true, c.worktreesDir, c.repoBases),
    projectLessonsLayer(c.project.slug, c.lessons ?? []),
    c.pipeline ? pipelineLayer(c.pipeline) : undefined,
    toolsLayer(c.toolsPrompt),
    extra(c.extraSystemPrompt),
  ]);
}

export function workerText(c: WorkerContext): string {
  const role = [
    '# Your role: worker',
    '',
    `An orchestrator launched you for one piece of the task "${c.title}" (task id \`${c.taskId}\`). Its session id is in $HOPP_PARENT_ID, and your instructions are your first message.`,
    '',
    '- Do your piece in your own folder; do not change other folders.',
    '- Never ask the human. When you are blocked or need a decision, ask your orchestrator: `hopp send $HOPP_PARENT_ID "<question>"`.',
    '- When you are done, report to your orchestrator with `hopp send $HOPP_PARENT_ID` what you did, where it is, and what is left.',
    '- Record anything that would have made your work better with `hopp lesson`.',
  ].join('\n');
  return join([hoppLayer(), role, projectLayer(c.project, false), projectLessonsLayer(c.project.slug, c.lessons ?? []), toolsLayer(c.toolsPrompt)]);
}

// What a start text carries of a project's open lessons at most.
export const LESSONS_MAX = 20;
export const LESSONS_MAX_BYTES = 4096;

// projectLessonsCommand: how to list a project's open lessons, whole.
export function projectLessonsCommand(slug: string): string {
  return `hopp lessons --label ${LABEL.project}=${slug} --label hopp.about=project --full`;
}

// projectLessonsLayer: the project's open lessons (newest first, as given),
// each with its id, at most LESSONS_MAX of them and about LESSONS_MAX_BYTES;
// the rest are counted with the command that lists them all.
export function projectLessonsLayer(slug: string, lessons: Lesson[]): string | undefined {
  if (lessons.length === 0) return undefined;
  const lines = [
    '## Lessons from earlier tasks in this project',
    '',
    `Agents before you wrote these down: the open lessons of this project (labels ${LABEL.project}=${slug} and hopp.about=project). When your work makes one obsolete (the fact is now in the repository's docs, a script or a fix), close it with \`hopp lessons close <id>\` and say so in your report; do not close a lesson you only read. All of them, whole: \`${projectLessonsCommand(slug)}\`.`,
    '',
  ];
  let bytes = 0;
  let shown = 0;
  for (const l of lessons) {
    const body = l.body.trim().replace(/\n+/g, '\n  ');
    const line = `- #${l.id} ${body}`;
    const size = Buffer.byteLength(line) + 1;
    if (shown >= LESSONS_MAX || (shown > 0 && bytes + size > LESSONS_MAX_BYTES)) break;
    lines.push(line);
    bytes += size;
    shown++;
  }
  const rest = lessons.length - shown;
  if (rest > 0) lines.push('', `${rest} more: \`${projectLessonsCommand(slug)}\``);
  return lines.join('\n');
}

// triageLessonsBrief: the brief of a task that works through a project's open
// lessons (the page offers it as "Triage with a task…").
export function triageLessonsBrief(slug: string): string {
  return [
    `Work through this project's open lessons: \`${projectLessonsCommand(slug)}\`.`,
    '',
    'For each lesson, put the knowledge where the next agent will find it without hopp: the repository\'s agent docs, toolbox or README, a script, or a code fix. Commit it on your branch, then close the lesson with `hopp lessons close <id>`.',
    'A lesson that is really about hopp itself (its commands, start texts, pipelines, tools or the app): relabel it with `hopp lessons label <id> hopp.about=hopp` and leave it open.',
    'A lesson that is wrong or no longer true: close it and say why.',
    '',
    'At the end, list what you did with each lesson, by its id.',
  ].join('\n');
}

// startedByLines: a task an agent started reports to that agent.
export function startedByLines(startedBy?: string | null): string[] {
  if (!startedBy) return [];
  return [
    '',
    `This task was started by the agent ${startedBy}, not typed by the human. Send it your questions about the request and your progress reports with \`hopp send ${startedBy}\`; decisions that belong to the human and stage approvals still go to the human with \`hopp ask\` / the feed.`,
  ];
}

// TASK_COMMANDS: how a long-lived agent finds projects and starts and follows
// tasks. Orchestrators and workers do not get them: they do not start tasks.
export const TASK_COMMANDS = [
  '## Starting and following tasks',
  '',
  'The human keeps projects (a repository or a folder, with rules) and pipelines (stages a task goes through) in the hopp app. You can start a task in a project; it gets its own orchestrator, which reports to you.',
  '',
  '- `hopp project ls` and `hopp project show <project>` list the projects and what each is.',
  '- `hopp pipeline ls` and `hopp pipeline show <pipeline>` list the pipelines and their stages.',
  '- `hopp task new --project <project> --brief "<what needs to be done>" [--pipeline <pipeline>]` starts a task (`--file <path>` or stdin for a long brief) and prints its id and its orchestrator\'s session. The orchestrator sends its questions and reports to you as messages; write to it with `hopp send <orchestrator> "<text>"`.',
  '- `hopp task ls`, `hopp task show <task>` and `hopp task feed <task>` follow tasks; `hopp task stop|resume|finish <task>` changes one.',
  '',
  'Add `--json` to any of them for machine-readable output.',
].join('\n');

export function agentText(c: AgentContext): string {
  const mail = 'Messages sent to you while your session was switched off wait in your mailbox: read them with `hopp inbox` (and `hopp inbox next`).';
  return join([hoppLayer() + '\n\n' + mail + '\n\n' + TASK_COMMANDS, toolsLayer(c.toolsPrompt)]);
}

function extra(text?: string): string | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  return '# From the human\n\n' + t;
}

// pipelineLayer: the stages in order, and the exact commands that keep the
// human's feed, stages and artifacts in step with the work. The labels are
// the contract with the app (LABEL in shared/shell.ts).
export function pipelineLayer(p: Pipeline): string {
  const lines = [
    `# Pipeline: ${p.name}`,
    '',
    'Work through these stages in order. The human follows the task in its feed, not in your terminal: everything they should see goes there with `hopp post`, `hopp artifact publish` and `hopp ask`, each labelled with its stage.',
    '',
    '## Stages',
    '',
  ];
  p.stages.forEach((st, i) => {
    const flags = [
      st.approval ? 'waits for the human\'s approval' : 'passes without approval',
      st.substages ? 'may have substages' : 'no substages',
    ].join('; ');
    lines.push(`${i + 1}. **${st.name}** — stage id \`${st.id}\`; ${flags}.`);
    if (st.does) lines.push(`   What it does: ${st.does}`);
    if (st.result) lines.push(`   What the result looks like: ${st.result}`);
  });
  const anySub = p.stages.some((s) => s.substages);
  lines.push(
    '',
    '## How to work a stage',
    '',
    'Replace <id> with the stage id. Put `--label hopp.stage=<id>` on everything of that stage.',
    '',
    '1. Start it, saying in one line what you will do:',
    '',
    '   hopp post --label hopp.stage=<id> --label hopp.event=stage_started "<what this stage will do>"',
    '',
    '2. Write progress, findings and decisions to the feed; attach artifacts by `name@version`:',
    '',
    '   hopp post --label hopp.stage=<id> "<text>" [--attach <name>@<version>]',
    '',
    '3. Publish every file the human should see as an artifact. Publishing the same name again makes a new version; the command prints `name@version`:',
    '',
    '   hopp artifact publish <file> --name <name> --label hopp.stage=<id>',
    '',
  );
  if (anySub) {
    lines.push(
      '4. Substages, only in stages that may have them: declare each one before you work on it:',
      '',
      '   hopp post --label hopp.stage=<id> --label hopp.substage=<slug> --label "hopp.substage_title=<title>" --label hopp.event=stage_started "<what this substage is>"',
      '',
      '   Then put `--label hopp.substage=<slug>` and `--label "hopp.substage_title=<title>"` on every post and artifact of that substage, beside its `hopp.stage` label.',
      '',
      '   A stage with substages is still submitted once, as a whole.',
      '',
    );
  }
  lines.push(
    `${anySub ? 5 : 4}. Submit the stage once its result is ready, attaching the versions to review:`,
    '',
    '   hopp ask "<stage name> is ready: <what to look at>" --label hopp.stage=<id> --label hopp.kind=submission --option Accept --option Return --attach <name>@<version>',
    '',
    '   The answer arrives as a message. Accept: the stage is done; start the next one. Return: the answer says what to fix; fix it, post what changed, publish new versions and submit again with a new ask. To take a submission back, `hopp ask withdraw <ask-id>`.',
    '',
    '- A stage that waits for approval is never passed without an Accept. Do not start the next stage before it.',
    '- A stage that passes without approval: when it is done, post `hopp post --label hopp.stage=<id> --label hopp.event=stage_done "<summary>"` and go on.',
    '- Before any paid call, ask with `hopp ask "<what it costs and why>" --label hopp.stage=<id> --label hopp.kind=paid --option Go --option Deny` and wait for Go. Never put a paid question into a submission.',
  );
  return lines.join('\n');
}

// The first message after a restore: the agent starts again with its start
// text and an empty conversation (no harness restores it).
export const RESUMED_ORCHESTRATOR =
  'You were restarted and your earlier conversation is gone. Follow "After a restart" in your instructions: find where the work stands (your branch, `hopp ls --mine`, `hopp messages $HOPP_SESSION_ID`), then continue the task. Do not redo what is done.';
export const RESUMED_AGENT =
  'Your session was restarted and your earlier conversation is gone. Read what waits for you with `hopp inbox`, see what was said with `hopp messages $HOPP_SESSION_ID`, then carry on.';

// baseLines: the commit the worktree started from, and a warning when the
// fetch before it failed.
export function baseLines(b: TaskBase | null | undefined): string[] {
  if (!b || !b.commit) return [];
  const date = b.committedAt ? new Date(b.committedAt * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'an unknown date';
  const lines = ['', `Your worktree started from ${b.ref} at commit ${b.commit.slice(0, 12)} (${date}).`];
  if (b.warning) {
    const branch = b.ref.startsWith('origin/') ? b.ref : 'origin/<default branch>';
    lines.push(
      `The fetch before the start failed (${b.warning}), so this may be behind GitHub. Run \`git fetch origin\` and compare with \`git log --oneline HEAD..${branch}\` before you rely on it; tell the human if it is behind.`,
    );
  }
  return lines;
}
