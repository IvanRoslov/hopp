import { describe, expect, it } from 'vitest';
import type { Pipeline, PipelineStage, Project } from '../../shared/shell';
import {
  addedWorkersMessage, agentText, allowedRepos, hoppLayer, orchestratorText, pipelineLayer, RESUMED_ORCHESTRATOR, resumedOrchestrator, stageText,
  workerProfileLines, workerText,
} from './startText';

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
    // Asks: own words, and withdrawing one settled another way.
    expect(t).toContain('Offer options only when they cover the cases: the human may answer in their own words instead.');
    expect(t).toContain('withdraw the ask with `hopp ask withdraw <id>` so it does not stay waiting');
    // Lessons of two kinds, both commands spelled out.
    expect(t).toContain('`hopp lesson --label hopp.about=project "<what the next agent in this project must know>"`');
    expect(t).toContain('`hopp lesson --label hopp.about=hopp "<what in hopp got in the way or is missing>"`');
    expect(t).toContain('One lesson is one fact');
    // Multi-line text goes through a file; stdin only when piped (lesson #3).
    expect(t).toContain('write it to a file first and use `hopp send <session> --file <path>`');
    expect(t).toContain('`--file -` reads stdin only when something is piped in');
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

  // Live runs, 2026-11-21: orchestrators of two harnesses did every stage
  // themselves; their context filled and the human's early decisions were lost.
  it('gives the work to workers and keeps the orchestrator to the human, the plan and the reports', () => {
    const t = orch();
    const at = (s: string) => t.indexOf(s);
    expect(at('## What you do, and what workers do')).toBeGreaterThan(at('# Your role: orchestrator'));
    expect(at('the work itself is done by workers')).toBeGreaterThan(at('## What you do, and what workers do'));
    expect(at('## Launching a worker')).toBeGreaterThan(at('the work itself is done by workers'));
    expect(t).toContain('"It is quicker to do it myself" is not a reason');
    expect(t).toContain('- checking a result: launch a fresh worker that has not seen the work, and give it the result and what it must meet;');
    expect(t).not.toContain('Plan the work, split it into pieces, and launch workers for the pieces.');
    expect(t).not.toContain('Go on with your own part');
  });

  it('says what a brief holds, passes a long one by file, and keeps a worker until the human accepts', () => {
    const t = orch();
    expect(t).toContain('A worker starts knowing nothing of this task. Its first message is its whole brief');
    expect(t).toContain('`--message-file <file>`');
    expect(t).toContain('Meanwhile brief the next piece, or wait');
    expect(t).toContain('ask the worker with `hopp send <worker session> "<question>"` rather than open its files');
    expect(t).toContain('4. Keep a worker until the human has accepted the work its piece is part of');
    expect(t).not.toContain('Once a worker\'s piece is reviewed and in your branch');
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

  it('reports briefly and by file, stays after its report, and reads its stage file first', () => {
    expect(t).toContain('- When you are done, report to your orchestrator with `hopp send $HOPP_PARENT_ID`, in at most fifteen lines: what you did, where it is (paths, branch, commit), what is left or unsure, and your questions. Do not paste file contents: the orchestrator keeps its context for the whole task. Put details into a file in your folder and name it in the report.');
    expect(t).toContain('- Stay after your report: remarks or questions may come, and you are the one who knows the piece.');
    expect(t).toContain('- When your instructions name a pipeline stage and its file, read that file first.');
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


describe('stage files', () => {
  const st = (over: Partial<PipelineStage> = {}): PipelineStage => ({
    id: 'spec', name: 'Spec', does: 'Write the spec.', result: 'A spec file.', substages: false, approval: true, ...over,
  });
  const pipe = (stages: PipelineStage[]): Pipeline => ({ id: 'dev', name: 'Development', stages, createdAt: 1, updatedAt: 1 });

  it('a stage text has its name, id, pipeline, both parts, and ends with one newline', () => {
    const s = st();
    expect(stageText(pipe([s]), s)).toBe(
      '# Stage: Spec (stage id `spec`)\n\n' +
        'One stage of the pipeline "Development". Your orchestrator\'s message says which part of it is yours. Where this text says to ask the human, or to post or publish to the feed, that is the orchestrator\'s: send it what it needs instead.\n\n' +
        '## What it does\n\nWrite the spec.\n\n' +
        '## What the result looks like\n\nA spec file.\n',
    );
  });

  it('a stage text leaves out a heading whose text is empty', () => {
    const noResult = stageText(pipe([st({ result: '' })]), st({ result: '' }));
    expect(noResult).toContain('## What it does\n\nWrite the spec.\n');
    expect(noResult).not.toContain('What the result looks like');
    expect(noResult.endsWith('Write the spec.\n')).toBe(true);
    const noDoes = stageText(pipe([st({ does: '  ' })]), st({ does: '  ' }));
    expect(noDoes).not.toContain('## What it does');
    expect(noDoes).toContain('## What the result looks like\n\nA spec file.\n');
  });

  it('the pipeline layer names each stage file for a worker and says who does a stage', () => {
    const p = pipe([st(), st({ id: 'build', name: 'Build', result: '' }), st({ id: 'ship', name: 'Ship', does: '', result: '' })]);
    const t = pipelineLayer(p, { spec: '/h/t/stage-spec.md', build: '/h/t/stage-build.md', ship: '/h/t/stage-ship.md' });
    expect(t).toContain('   What the result looks like: A spec file.\n   For a worker: /h/t/stage-spec.md\n');
    expect(t).toContain('   What it does: Write the spec.\n   For a worker: /h/t/stage-build.md\n');
    expect(t).toContain('stage id `ship`; waits for the human\'s approval; no substages.\n   For a worker: /h/t/stage-ship.md\n');
    expect(t).toContain('Work through these stages in order. The human follows the task in its feed, not in your terminal: everything they should see goes there with `hopp post`, `hopp artifact publish` and `hopp ask`, each labelled with its stage.\n\n');
    expect(t).toContain('The stage texts say what must be done and what the result looks like. They are written to the task, not to you personally: under your role, workers make each stage\'s result, and you run the stage in the feed (start it, post, publish, submit, ask). Give a worker the stage\'s file (the "For a worker" line) instead of retyping the stage, and add what is specific to its piece.');
  });

  it('without stage files the pipeline layer has no "For a worker" lines and the shorter paragraph', () => {
    for (const t of [pipelineLayer(pipe([st()])), pipelineLayer(pipe([st()]), {})]) {
      expect(t).not.toContain('For a worker');
      expect(t).toContain('workers make each stage\'s result, and you run the stage in the feed (start it, post, publish, submit, ask).\n');
      expect(t).not.toContain('instead of retyping the stage');
    }
  });

  it('the orchestrator text passes its stage files to the pipeline layer', () => {
    const t = orch({ pipeline: pipe([st()]), stageFiles: { spec: '/h/t/stage-spec.md' } });
    expect(t).toContain('   For a worker: /h/t/stage-spec.md');
    expect(orch()).not.toContain('# Pipeline');
  });
});

describe('workers added after the launch', () => {
  const opus = { profile: 'opus-max', harness: 'claude-code', file: '/h/shell/tasks/t1/worker-claude-code.md' };
  const line = "- `opus-max` (claude-code): `--system-prompt-file /h/shell/tasks/t1/worker-claude-code.md`";

  it('the start text lists the profiles with the same lines as before', () => {
    const t = orch();
    expect(t).toContain(
      '   - `cheap` (deepseek): `--system-prompt-file /h/shell/tasks/fix-header/worker-deepseek.md`\n' +
        '   - `codex-high` (codex): `--system-prompt-file /h/shell/tasks/fix-header/worker-codex.md`\n',
    );
    expect(workerProfileLines([opus])).toEqual(['   ' + line]);
  });

  it('the message to a running orchestrator names each profile and its file', () => {
    const m = addedWorkersMessage([opus]);
    expect(m).toContain(line);
    expect(m).toContain('in addition to the ones in your instructions');
    expect(m).toContain('Workers that already run keep their models.');
  });

  it('the resume message repeats the added profiles, and is unchanged without them', () => {
    expect(resumedOrchestrator([])).toBe(RESUMED_ORCHESTRATOR);
    const m = resumedOrchestrator([opus]);
    expect(m.startsWith(RESUMED_ORCHESTRATOR)).toBe(true);
    expect(m).toContain(line);
    expect(m).toContain('which your instructions do not list');
  });
});
