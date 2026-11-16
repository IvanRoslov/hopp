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
    expect(t).toContain('hopp ask "Fix the header: ready for review" --option Accept --option Revise');
    expect(t).toContain('Workers never ask the human');
    expect(t).toContain('hopp lesson');
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
});
