// A task with a pipeline: a starter pipeline edited and saved, a task
// launched with it, and the feed following the orchestrator: a post, an
// artifact tile served through hopp-artifact://, a submission returned with
// text and then accepted, and the stages panel in step.
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeAsk } from '../test/fakeDaemon';
import type { Post } from '../src/shared/shell';
import { World } from './world';

// A 2×2 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==',
  'base64',
);

test('a pipeline task from the editor to an accepted stage', async () => {
  const w = new World();
  const repo = w.repo('site');
  try {
    const page = await w.start();
    await page.getByLabel('Name').fill('Site');
    await page.getByRole('button', { name: 'Advanced' }).click();
    await page.getByLabel('Worktree for the orchestrator').fill(repo);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByLabel('What needs to be done?')).toBeVisible();

    // Edit the starter "Development" pipeline down to two stages and save.
    await page.getByRole('button', { name: 'Pipelines' }).click();
    await page.getByTestId('pipeline-row').filter({ hasText: 'Development' }).click();
    await page.getByLabel('Pipeline name').fill('Two-stage dev');
    const stages = page.getByTestId('pipeline-stage');
    await expect(stages).toHaveCount(4);
    await stages.nth(3).getByRole('button', { name: 'Delete' }).click();
    await stages.nth(2).getByRole('button', { name: 'Delete' }).click();
    await expect(stages).toHaveCount(2);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => {
      const st = JSON.parse(readFileSync(join(w.home, 'shell', 'state.json'), 'utf8'));
      return st.pipelines.find((p: { name: string }) => p.name === 'Two-stage dev')?.stages.length;
    }).toBe(2);

    // Launch a task with it.
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByTestId('pick-pipeline').click();
    await page.getByRole('menuitemradio', { name: 'Two-stage dev' }).click();
    await page.getByLabel('What needs to be done?').fill('Add a dark mode');
    await page.getByRole('button', { name: 'Start the task' }).click();
    await expect(page.getByTestId('pipeline-task-view')).toBeVisible({ timeout: 15_000 });
    const id = String(w.d.created.at(-1)!['id']);
    expect(id).toBe('add-a-dark-mode');
    const sp = String(w.d.created.at(-1)!['system_prompt']);
    expect(sp).toContain('# Pipeline: Two-stage dev');
    expect(sp).toContain('stage id `analyse-the-problem`');

    const L = (o: Record<string, string>) => ({ 'hopp.project': 'site', 'hopp.task': id, 'hopp.role': 'orchestrator', ...o });
    const post = (body: string, labels: Record<string, string>, attachments: string[] = []) => {
      const p: Post = { id: w.d.posts.length + 1, from: id, labels: L(labels), body, attachments, created_at: Math.floor(Date.now() / 1000) };
      w.d.posts.push(p);
      w.d.publish('post.added', id, { id: p.id, post_labels: p.labels });
    };
    const artifact = (version: number) => {
      const dir = join(w.home, 'artifacts', id, 'notes', 'v' + version);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'notes.png');
      writeFileSync(path, PNG);
      w.d.artifacts.push({
        id: w.d.artifacts.length + 1, scope: id, name: 'notes', version, filename: 'notes.png', mime: 'image/png', size: PNG.length,
        sha256: '', from: id, labels: L({ 'hopp.stage': 'analyse-the-problem' }), created_at: Math.floor(Date.now() / 1000), path,
      });
      w.d.publish('artifact.published', id, { id: w.d.artifacts.length, artifact_labels: L({ 'hopp.stage': 'analyse-the-problem' }) });
    };
    const submit = (askId: number, ref: string) => {
      w.d.asks.push(makeAsk(askId, id, {
        body: 'Analysis is ready', options: ['Accept', 'Return'], attachments: [ref],
        labels: L({ 'hopp.stage': 'analyse-the-problem', 'hopp.kind': 'submission' }), created_at: Math.floor(Date.now() / 1000),
      }));
      w.d.publish('ask.created', id, { id: askId, ask_labels: w.d.asks.at(-1)!.labels });
    };

    // The orchestrator starts the stage and posts with an artifact.
    post('Starting the analysis', { 'hopp.stage': 'analyse-the-problem', 'hopp.event': 'stage_started' });
    artifact(1);
    post('The theme lives in tokens.css; see the notes.', { 'hopp.stage': 'analyse-the-problem' }, ['notes@1']);
    await expect(page.getByText('The theme lives in tokens.css; see the notes.')).toBeVisible({ timeout: 10_000 });
    const tile = page.getByTestId('artifact-tile-notes@1').first();
    await expect(tile).toBeVisible();
    // The image really loads through hopp-artifact://.
    await expect.poll(() => tile.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2);

    // Submitted, returned with text.
    submit(101, 'notes@1');
    const block = page.getByTestId('ask-101');
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('stages-button')).toHaveText('Stages · 1');
    await block.getByRole('button', { name: 'Return' }).click();
    await block.getByLabel('What should be fixed?').fill('Also cover the terminal colors.');
    await block.getByRole('button', { name: 'Return' }).click();
    await expect.poll(() => w.d.asks.find((a) => a.id === 101)).toMatchObject({ status: 'answered', choice: 'Return', answer: 'Also cover the terminal colors.' });
    // The answered question, then the answer line, the text of what to fix as markdown.
    await expect(page.locator('.entry-quiet').filter({ hasText: 'Analysis is ready' }).locator('.entry-answer')).toHaveText('You answered: Return — Also cover the terminal colors.');

    // Fixed, submitted again with version 2, accepted.
    artifact(2);
    submit(102, 'notes@2');
    await expect(page.getByTestId('ask-102')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('ask-102').getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => w.d.asks.find((a) => a.id === 102)?.choice).toBe('Accept');

    // The stages panel follows.
    await page.getByTestId('stages-button').click();
    const panel = page.getByTestId('stages-panel');
    await expect(panel.getByTestId('stage-analyse-the-problem')).toContainText('accepted');
    await expect(panel.getByTestId('stage-design')).toContainText('not started');
    await expect(page.getByTestId('stages-button')).toHaveText('Stages');

    // The human's line goes to the orchestrator and into the feed.
    await page.getByLabel('Write to the orchestrator').fill('Start the design next.');
    await page.getByLabel('Write to the orchestrator').press('Enter');
    await expect.poll(() => w.d.messages.at(-1)).toMatchObject({ to: id, body: 'Start the design next.' });
    await expect.poll(() => w.d.posts.at(-1)).toMatchObject({ from: '', body: 'Start the design next.' });
  } finally {
    await w.dispose();
  }
});
