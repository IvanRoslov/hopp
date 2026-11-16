// Start texts: what each session is told when it starts. Pure functions, built
// in layers: (1) hopp, (2) role, (3) project, (4) tools, then the human's
// extra system prompt. A long-lived agent gets layers 1 and 4 only; its role
// lives in its own folder.
import type { Project } from '../../shared/shell';

// hoppLayer: you run inside hopp, and the commands every session uses.
export function hoppLayer(): string {
  return [
    '# You run inside hopp',
    '',
    'hopp runs AI agents in tmux sessions and carries messages between them. Your session id is in $HOPP_SESSION_ID; the session that launched you, if any, is in $HOPP_PARENT_ID. Use the `hopp` command:',
    '',
    '- `hopp send <session> "<text>"` sends a message to another session; for long or markdown text use `hopp send <session> --file <path>` (`--file -` reads stdin). Messages to you arrive in your input.',
    '- `hopp ls --mine` lists the sessions you launched; `hopp ls` lists every running session.',
    '- `hopp ask "<question>" [--option <choice>]... [--wait]` asks the human; the answer comes back as a message (and as the output of `--wait`).',
    '- `hopp lesson "<text>"` records what would have made this work better: a missing tool, a confusing instruction, a step that should be automatic. Write one whenever you notice something; the human reads them.',
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
}

export interface WorkerContext {
  project: Project;
  taskId: string;
  title: string;
  toolsPrompt: string;
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

function projectLayer(p: Project, forOrchestrator: boolean, worktreesDir?: string): string {
  const lines = ['# Project: ' + p.name, ''];
  if (p.description) lines.push(p.description, '');
  if (forOrchestrator) {
    const repos = allowedRepos(p);
    if (repos.length > 0) {
      lines.push('Workers may run only in worktrees of these repositories, made under ' + worktreesDir + ':', '');
      for (const r of repos) lines.push('- ' + r);
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
  const prepare =
    repos.length > 0
      ? [
          `   git -C <repository> worktree add -b hopp/${c.taskId}-${name} ${dir}`,
          '',
          '   where <repository> is one of the repositories listed under the project' +
            (c.project.workerRepos.length === 0 ? ' (the orchestrator\'s repository).' : '.'),
        ]
      : [`   mkdir -p ${dir}`];
  const profiles = c.workers.map((w) => `   - \`${w.profile}\` (${w.harness}): \`--system-prompt-file ${w.file}\``);
  const role = [
    '# Your role: orchestrator',
    '',
    `You lead the task "${c.title}" (task id \`${c.taskId}\`). Your folder is ${c.taskDir}. The human's request is your first message.`,
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
    `3. Workers report back to you with \`hopp send\`. Check on them with \`hopp ls --mine\`.`,
    '',
    '## The human',
    '',
    'Ask the human with `hopp ask` when a decision is theirs. Workers never ask the human: they ask you.',
    '',
    `When the work is ready, say so with \`hopp ask "${c.title}: ready for review" --option Accept --option Revise\` and wait for the answer. On Revise, continue with what the human asked for.`,
    '',
    'Record anything that would have made this task go better with `hopp lesson`.',
  ].join('\n');
  return join([hoppLayer(), role, projectLayer(c.project, true, c.worktreesDir), toolsLayer(c.toolsPrompt), extra(c.extraSystemPrompt)]);
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
  return join([hoppLayer(), role, projectLayer(c.project, false), toolsLayer(c.toolsPrompt)]);
}

export function agentText(c: AgentContext): string {
  const mail = 'Messages sent to you while your session was switched off wait in your mailbox: read them with `hopp inbox` (and `hopp inbox next`).';
  return join([hoppLayer() + '\n\n' + mail, toolsLayer(c.toolsPrompt)]);
}

function extra(text?: string): string | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  return '# From the human\n\n' + t;
}
