import { describe, expect, it } from 'vitest';
import type { Project } from '../../shared/shell';
import { agentText, allowedRepos, hoppLayer, orchestratorText, workerText } from './startText';

const project = (over: Partial<Project> = {}): Project => ({
  slug: 'site', name: 'Site', description: 'The marketing site.', orchestratorRepo: '/r/site',
  workerRepos: [], guardrails: 'Never push to main.', createdAt: 1, ...over,
});

const TOOLS = '## Tools\n\n- fetcher — Fetch a page\n\n1. Before you use a tool, read `hopp tools show NAME`.\n';

const orch = (over: Partial<Parameters<typeof orchestratorText>[0]> = {}) =>
  orchestratorText({
    project: project(), taskId: 'fix-header', title: 'Fix the header', taskDir: '/h/worktrees/site/fix-header',
    worktreesDir: '/h/worktrees/site',
    workers: [
      { profile: 'cheap', harness: 'deepseek', file: '/h/shell/tasks/fix-header/worker-deepseek.md' },
      { profile: 'codex-high', harness: 'codex', file: '/h/shell/tasks/fix-header/worker-codex.md' },
    ],
    toolsPrompt: TOOLS, ...over,
  });

describe('hoppLayer', () => {
  it('names the commands every session uses', () => {
    const t = hoppLayer();
    for (const w of ['hopp send', 'hopp ask', 'hopp lesson', 'hopp tools', '$HOPP_SESSION_ID', '$HOPP_PARENT_ID']) expect(t).toContain(w);
  });
});

describe('orchestratorText', () => {
  it('has the layers in order: hopp, role, project, tools, extra', () => {
    const t = orch({ extraSystemPrompt: 'Prefer small commits.' });
    const at = (s: string) => t.indexOf(s);
    expect(at('# You run inside hopp')).toBe(0);
    expect(at('# Your role: orchestrator')).toBeGreaterThan(0);
    expect(at('# Project: Site')).toBeGreaterThan(at('# Your role: orchestrator'));
    expect(at('- fetcher — Fetch a page')).toBeGreaterThan(at('# Project: Site'));
    expect(at('Prefer small commits.')).toBeGreaterThan(at('- fetcher'));
  });

  it('says exactly how to launch a worker, with each allowed profile and its file', () => {
    const t = orch();
    expect(t).toContain('git -C <repository> worktree add -b hopp/fix-header-<name> /h/worktrees/site/fix-header-<name>');
    expect(t).toContain(
      'hopp run /h/worktrees/site/fix-header-<name> --name fix-header-<name> --profile <profile> --label hopp.role=worker --system-prompt-file <file> -m',
    );
    expect(t).toContain('`cheap` (deepseek): `--system-prompt-file /h/shell/tasks/fix-header/worker-deepseek.md`');
    expect(t).toContain('`codex-high` (codex): `--system-prompt-file /h/shell/tasks/fix-header/worker-codex.md`');
  });

  it('lists where workers may run: the orchestrator repository and the worker repositories', () => {
    const t = orch({ project: project({ workerRepos: ['/r/api', '/r/site'] }) });
    expect(t).toContain('- /r/site\n- /r/api');
    expect(t.match(/- \/r\/site/g)).toHaveLength(1);
    expect(allowedRepos(project({ workerRepos: ['/r/api'] }))).toEqual(['/r/site', '/r/api']);
  });

  it('without a repository tells to make a plain folder', () => {
    const t = orch({ project: project({ orchestratorRepo: null }) });
    expect(t).toContain('mkdir -p /h/worktrees/site/fix-header-<name>');
    expect(t).not.toContain('worktree add');
    expect(t).toContain('has no repository');
  });

  it('carries the guardrails, the review ask, and the rule that workers do not ask the human', () => {
    const t = orch();
    expect(t).toContain('## Guardrails\n\nNever push to main.');
    expect(t).toContain('hopp ask "Ready for review: <what is done and where, in one line>" --option Accept --option Revise');
    expect(t).toContain('Workers never ask the human');
    expect(t).toContain('hopp lesson');
  });

  // Live run, 2026-11-17: the review ask carried the title cut at 60
  // characters mid-word ("… on your bra: ready for review").
  it('does not put the task title into the review ask', () => {
    const t = orch({ title: 'Add two files to this repository and commit them on your bra' });
    expect(t).not.toContain('on your bra: ready for review');
  });

  // Live runs: the orchestrator polled `git log` and `hopp ls` while a worker
  // worked, and left the worker running after merging its piece.
  it('says a worker reports by message, so no polling, and to stop a worker once its piece is in', () => {
    const t = orch();
    expect(t).toContain('arrives in your input as a message');
    expect(t).toContain('do not poll');
    expect(t).toContain('hopp kill <worker session>');
  });

  // Live run: an English brief got Russian replies (the human's global prompt).
  it('says to write to the human in the language of the brief', () => {
    expect(orch()).toContain('in the language of the task\'s brief');
  });

  // Live run: Resume relaunched the orchestrator with its start text but no
  // first message and no conversation; it sat at an empty prompt.
  it('repeats the brief and says how to pick up the work after a restart', () => {
    const t = orch({ brief: 'Fix the header.\nKeep the logo.' });
    expect(t).toContain('## The task\n\nFix the header.\nKeep the logo.');
    expect(t).toContain('hopp ls --mine');
    expect(t).toContain('hopp messages $HOPP_SESSION_ID');
    expect(orch()).not.toContain('## The task');
  });

  it('without tools says how to get one, and leaves out an empty extra prompt and empty guardrails', () => {
    const t = orch({ toolsPrompt: '', extraSystemPrompt: '   ', project: project({ guardrails: '' }) });
    expect(t).toContain('The tool catalog has no tools for you yet');
    expect(t).not.toContain('# From the human');
    expect(t).not.toContain('Guardrails');
  });

  it('never depends on an agent name', () => {
    expect(orch()).not.toMatch(/\bcto\b/i);
  });
});

describe('workerText', () => {
  const t = workerText({ project: project(), taskId: 'fix-header', title: 'Fix the header', toolsPrompt: TOOLS });

  it('is a worker that reports to its parent and never asks the human', () => {
    expect(t).toContain('# Your role: worker');
    expect(t).toContain('Never ask the human');
    expect(t).toContain('hopp send $HOPP_PARENT_ID');
    expect(t).not.toContain('# Your role: orchestrator');
    expect(t).not.toContain('ready for review');
  });

  it('carries the project and its guardrails, but not where workers may run', () => {
    expect(t).toContain('# Project: Site');
    expect(t).toContain('Never push to main.');
    expect(t).not.toContain('Workers may run only');
    expect(t).toContain('- fetcher — Fetch a page');
  });
});

describe('agentText', () => {
  it('has the hopp and tools layers only, plus its mailbox', () => {
    const t = agentText({ toolsPrompt: TOOLS });
    expect(t.startsWith('# You run inside hopp')).toBe(true);
    expect(t).toContain('- fetcher — Fetch a page');
    expect(t).toContain('hopp inbox');
    expect(t).not.toContain('# Your role');
    expect(t).not.toContain('# Project');
  });

  it('names the task commands, which orchestrators and workers do not get', () => {
    const t = agentText({ toolsPrompt: TOOLS });
    for (const w of ['hopp project ls', 'hopp pipeline ls', 'hopp task new --project', 'hopp task show', 'hopp task feed']) expect(t).toContain(w);
    expect(orch()).not.toContain('hopp task new');
    expect(workerText({ project: project(), taskId: 'x', title: 'X', toolsPrompt: TOOLS })).not.toContain('hopp task new');
  });
});

describe('a task started by an agent', () => {
  it('tells the orchestrator whom to report to, and only then', () => {
    const t = orch({ startedBy: 'cto' });
    expect(t).toContain('This task was started by the agent cto, not typed by the human.');
    expect(t).toContain('`hopp send cto`');
    expect(t).toContain('stage approvals still go to the human');
    expect(orch()).not.toContain('started by the agent');
  });
});

