// The pipeline flow against the real daemon, without an LLM: hopp built from
// daemon/ runs on a temp HOPP_HOME with a temp HOME and its own tmux server;
// the "agent" is a fake codex that only echoes. The test plays the
// orchestrator with the exact commands its start text gives and checks that
// the app shows the result. Run with HOPP_E2E_REAL=1 (needs Go and tmux).
import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appDir } from './launch';
import { hoppBinary } from './world';

const tmux = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
const enabled = process.env['HOPP_E2E_REAL'] === '1' && !!tmux && spawnSync('go', ['version']).status === 0;

// A 2×2 PNG in two colors, one per version.
const png = (b64: string) => Buffer.from(b64, 'base64');
const PNG1 = png('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==');
const PNG2 = png('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGNgYGD4z8DAwMDAwAAAEgAB0n0k3wAAAABJRU5ErkJggg==');

test.skip(!enabled, 'set HOPP_E2E_REAL=1 (needs Go and tmux)');

test('the start text\'s commands drive the feed, stages and artifacts', async () => {
  test.setTimeout(180_000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hre-')));
  const home = join(root, 'h');
  const userHome = join(root, 'u');
  const fakebin = join(root, 'fb');
  for (const d of [home, userHome, fakebin, join(root, 'tx')]) mkdirSync(d, { recursive: true });
  const hopp = hoppBinary();
  symlinkSync(hopp, join(fakebin, 'hopp'));
  writeFileSync(join(fakebin, 'codex'), '#!/bin/sh\necho "fake codex ready"\nexec cat\n');
  chmodSync(join(fakebin, 'codex'), 0o755);
  const PATH = [fakebin, dirname(tmux!), '/usr/bin', '/bin'].join(':');
  const env: Record<string, string> = {
    PATH, HOME: userHome, HOPP_HOME: home, TMUX_TMPDIR: join(root, 'tx'), CODEX_HOME: join(userHome, '.codex'),
    HOPP_SESSION_ID: '', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
  };
  const git = (...a: string[]) => execFileSync('git', a, { env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString();
  const repo = join(root, 'site');
  mkdirSync(repo);
  git('-C', repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# site\n');
  git('-C', repo, '-c', 'user.email=e@x.invalid', '-c', 'user.name=e', 'add', '.');
  git('-C', repo, '-c', 'user.email=e@x.invalid', '-c', 'user.name=e', 'commit', '-q', '-m', 'init');

  let daemon: ChildProcess | null = null;
  const app0 = { app: null as Awaited<ReturnType<typeof electron.launch>> | null };
  const h = (args: string[], extra: Record<string, string> = {}) => execFileSync(hopp, args, { env: { ...env, ...extra } }).toString().trim();
  try {
    daemon = spawn(hopp, ['daemon', 'run'], { env, stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(join(home, 'hopp.sock')); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    h(['models', 'add', 'fake-codex', '--agent', 'codex', '--description', 'a fake codex that only echoes']);

    const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...(process.env as Record<string, string>), ...env, SHELL: '/usr/bin/false' } });
    app0.app = app;
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});

    // Project with the repository, then a task on the starter Development pipeline.
    await page.getByLabel('Name').fill('Site');
    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Worktree for the orchestrator').fill(repo);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByLabel('What needs to be done?').fill('Add a dark mode');
    await page.getByTestId('pick-orchestrator').click();
    await page.getByRole('menuitemradio', { name: /fake-codex/ }).click();
    await page.getByTestId('pick-pipeline').click();
    await page.getByRole('menuitemradio', { name: 'Development' }).click();
    await page.getByRole('button', { name: 'Start the task' }).click();
    await expect(page.getByTestId('pipeline-task-view')).toBeVisible({ timeout: 30_000 });

    const id = 'add-a-dark-mode';
    const text = readFileSync(join(home, 'shell', 'tasks', id, 'orchestrator.md'), 'utf8');
    const stage = 'analyse-the-problem';
    // The commands the start text gives, verbatim, before <id> and the
    // other placeholders are filled in.
    const templates = [
      'hopp post --label hopp.stage=<id> --label hopp.event=stage_started "<what this stage will do>"',
      'hopp post --label hopp.stage=<id> "<text>" [--attach <name>@<version>]',
      'hopp artifact publish <file> --name <name> --label hopp.stage=<id>',
      'hopp ask "<stage name> is ready: <what to look at>" --label hopp.stage=<id> --label hopp.kind=submission --option Accept --option Return --attach <name>@<version>',
      'hopp ask "<what it costs and why>" --label hopp.stage=<id> --label hopp.kind=paid --option Go --option Deny',
    ];
    for (const t of templates) expect(text, t).toContain(t);
    expect(text).toContain(`stage id \`${stage}\``);

    // Play the orchestrator, as its session would: HOPP_SESSION_ID = the task.
    const orch = (args: string[]) => h(args, { HOPP_SESSION_ID: id });
    orch(['post', '--label', `hopp.stage=${stage}`, '--label', 'hopp.event=stage_started', 'Reading the theme code']);
    const file = join(root, 'notes.png');
    writeFileSync(file, PNG1);
    expect(orch(['artifact', 'publish', file, '--name', 'notes', '--label', `hopp.stage=${stage}`])).toBe('notes@1');
    orch(['post', '--label', `hopp.stage=${stage}`, 'The theme lives in tokens.css.', '--attach', 'notes@1']);

    await expect(page.getByText('The theme lives in tokens.css.')).toBeVisible({ timeout: 15_000 });
    const entry = page.locator('article', { hasText: 'The theme lives in tokens.css.' });
    await expect(entry.locator('.entry-meta')).toContainText('Orchestrator');
    await expect(entry.locator('.entry-meta')).toContainText('Analyse the problem');
    await expect.poll(() => entry.getByTestId('artifact-tile-notes@1').locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);

    // Submit; the human returns it with text.
    const ask1 = orch(['ask', 'Analysis is ready: see the notes', '--label', `hopp.stage=${stage}`, '--label', 'hopp.kind=submission', '--option', 'Accept', '--option', 'Return', '--attach', 'notes@1']);
    const askId1 = /(\d+)/.exec(ask1)![1]!;
    const block1 = page.getByTestId(`ask-${askId1}`);
    await expect(block1).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('stages-button')).toHaveText('Stages · 1');
    await block1.getByRole('button', { name: 'Return' }).click();
    await block1.getByLabel('What should be fixed?').fill('Also cover the terminal colors.');
    await block1.getByRole('button', { name: 'Return' }).click();
    await expect.poll(() => JSON.parse(h(['--json', 'asks', '--all'])).asks.find((a: { id: number }) => a.id === Number(askId1)))
      .toMatchObject({ status: 'answered', choice: 'Return', answer: 'Also cover the terminal colors.' });

    // Fix, version 2, submit again; a paid ask on the way; accepted.
    writeFileSync(file, PNG2);
    expect(orch(['artifact', 'publish', file, '--name', 'notes', '--label', `hopp.stage=${stage}`])).toBe('notes@2');
    const paid = orch(['ask', 'Render previews: 2 credits', '--label', `hopp.stage=${stage}`, '--label', 'hopp.kind=paid', '--option', 'Go', '--option', 'Deny']);
    const paidId = /(\d+)/.exec(paid)![1]!;
    await page.getByTestId(`ask-${paidId}`).getByRole('button', { name: 'Go' }).click();
    await expect.poll(() => JSON.parse(h(['--json', 'asks', '--all'])).asks.find((a: { id: number }) => a.id === Number(paidId))?.choice).toBe('Go');
    const ask2 = orch(['ask', 'Analysis is ready again', '--label', `hopp.stage=${stage}`, '--label', 'hopp.kind=submission', '--option', 'Accept', '--option', 'Return', '--attach', 'notes@2']);
    const askId2 = /(\d+)/.exec(ask2)![1]!;
    await page.getByTestId(`ask-${askId2}`).getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => JSON.parse(h(['--json', 'asks', '--all'])).asks.find((a: { id: number }) => a.id === Number(askId2))?.choice).toBe('Accept');

    // The stages panel and the artifacts panel follow.
    await page.getByTestId('stages-button').click();
    await expect(page.getByTestId(`stage-${stage}`)).toContainText('accepted', { timeout: 10_000 });
    await expect(page.getByTestId('stage-design')).toContainText('not started');
    await page.getByTestId('artifacts-button').click();
    await expect(page.getByTestId('artifacts-panel').getByTestId('artifact-tile-notes@2')).toContainText('Image · version 2');

    // The human's line reaches the orchestrator's session as a message.
    await page.getByLabel('Write to the orchestrator').fill('Next: the design.');
    await page.getByLabel('Write to the orchestrator').press('Enter');
    await expect.poll(() => JSON.parse(h(['--json', 'posts', '--label', `hopp.task=${id}`])).posts.at(-1)).toMatchObject({ from: '', body: 'Next: the design.' });
    await expect.poll(() => JSON.parse(h(['--json', 'messages', id])).messages?.at?.(-1)?.body ?? JSON.stringify(JSON.parse(h(['--json', 'messages', id])))).toContain('Next: the design.');

    await page.screenshot({ path: join(root, 'final.png') });
  } finally {
    await app0.app?.close().catch(() => {});
    try {
      h(['kill', 'add-a-dark-mode']);
    } catch {
      // not running
    }
    daemon?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    spawnSync(tmux!, ['kill-server'], { env });
    rmSync(root, { recursive: true, force: true });
  }
});
