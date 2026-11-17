// The terminal never shows more columns or rows than fit in its visible box:
// the right end of a long line and the bottom row stay on screen, at any
// window width, with the questions column open or closed, and in the right
// panel of a task with a pipeline. Regression: xterm puts the class
// `terminal` on its own root, so a style meant for our host box (an inset)
// applied twice and the fit counted 36 px the human never saw.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeSession } from '../test/fakeDaemon';
import { World } from './world';

// The attached "agent" prints its pty size on start and on every resize.
const SIZE_REPORTER = 'report(){ set -- $(stty size); echo "pty rows=$1 cols=$2"; }; report; trap report WINCH; while :; do sleep 1; done';

interface Fit {
  host: { left: number; right: number; top: number; bottom: number };
  xterm: { left: number; right: number; top: number; bottom: number };
  screenRight: number;
  screenBottom: number;
  cols: number;
  pty: string | null;
}

async function measure(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const rect = (sel: string) => {
      const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const host = rect('[data-testid="terminal"]');
    const xterm = rect('[data-testid="terminal"] .xterm');
    const screen = rect('[data-testid="terminal"] .xterm-screen');
    const text = (document.querySelector('[data-testid="terminal"] .xterm-rows') as HTMLElement).innerText;
    const all = [...text.matchAll(/pty rows=\d+ cols=(\d+)/g)];
    const last = all.length ? all[all.length - 1] : null;
    return {
      host,
      xterm,
      screenRight: screen.right,
      screenBottom: screen.bottom,
      cols: last ? Number(last[1]) : 0,
      pty: last ? last[0] : null,
    };
  });
}

// The scrollbar xterm reserves on the right (FitAddon's default).
const SCROLLBAR = 14;

async function expectFits(page: Page, where: string) {
  // Wait for a resize to settle: the debounced fit, then the pty's report.
  await expect.poll(async () => {
    const a = await measure(page);
    await page.waitForTimeout(250);
    const b = await measure(page);
    return a.pty !== null && a.pty === b.pty && a.screenRight === b.screenRight;
  }, { message: where, timeout: 10_000 }).toBe(true);
  const f = await measure(page);
  // xterm fills the host box exactly: no second inset inside it.
  expect(f.xterm, where).toEqual(f.host);
  // The column grid and the scrollbar fit inside the visible box; so do the rows.
  expect(f.screenRight + SCROLLBAR, where).toBeLessThanOrEqual(f.host.right + 0.5);
  expect(f.screenBottom, where).toBeLessThanOrEqual(f.host.bottom + 0.5);
  // The pty heard of the resize.
  expect(f.cols, where).toBeGreaterThan(20);
}

test('the terminal fits its box: no pipeline, questions open and closed, several widths', async () => {
  const w = new World();
  w.d.defaultAttach = ['/bin/sh', '-c', SIZE_REPORTER];
  w.seedTask('fit-task', 'Fit check');
  w.d.sessions = [makeSession('fit-task', { labels: { 'hopp.project': 'site', 'hopp.task': 'fit-task', 'hopp.role': 'orchestrator' } })];
  try {
    const page = await w.start();
    await page.getByText('Fit check').first().click();
    await expect(page.getByTestId('terminal')).toBeVisible();
    for (const width of [1100, 1500, 2000, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await expectFits(page, `questions closed at ${width}`);
    }
    await page.getByTestId('questions-button').click();
    for (const width of [2000, 1300, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      await expectFits(page, `questions open at ${width}`);
    }
  } finally {
    await w.dispose();
  }
});

test('the terminal fits its box in the right panel of a task with a pipeline', async () => {
  const w = new World();
  w.d.defaultAttach = ['/bin/sh', '-c', SIZE_REPORTER];
  w.seedTask('pipe-task', 'Pipe check');
  // Give the seeded task a one-stage pipeline.
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].pipeline = {
    id: 'one', name: 'One', createdAt: 1, updatedAt: 1,
    stages: [{ id: 'build', name: 'Build', does: '', result: '', substages: false, approval: true }],
  };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession('pipe-task', { labels: { 'hopp.project': 'site', 'hopp.task': 'pipe-task', 'hopp.role': 'orchestrator' } })];
  try {
    const page = await w.start();
    await page.getByText('Pipe check').first().click();
    await expect(page.getByTestId('pipeline-task-view')).toBeVisible();
    await page.getByTestId('terminal-button').click();
    await expect(page.getByTestId('terminal')).toBeVisible();
    for (const width of [1300, 2000]) {
      await page.setViewportSize({ width, height: 900 });
      await expectFits(page, `pipeline panel at ${width}`);
    }
  } finally {
    await w.dispose();
  }
});

test('the terminal refits when the header takes a second line and gives it back', async () => {
  const w = new World();
  w.d.defaultAttach = ['/bin/sh', '-c', SIZE_REPORTER];
  w.seedTask('warn-task', 'A task whose title is long enough to be cut with an ellipsis in a narrow window, as Ivan saw');
  const file = join(w.home, 'shell', 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  st.tasks[0].base = { ref: 'origin/main', commit: '4b2e7aa91c', committedAt: 1763400000, fetched: false, warning: 'git fetch: Could not resolve host: github.com' };
  writeFileSync(file, JSON.stringify(st));
  w.d.sessions = [makeSession('warn-task', { labels: { 'hopp.project': 'site', 'hopp.task': 'warn-task', 'hopp.role': 'orchestrator' } })];
  try {
    const page = await w.start();
    await page.getByTestId('task-row').first().click();
    await expect(page.getByTestId('base-warning')).toBeVisible();
    const headerHeight = async () => (await page.locator('.task-top').boundingBox())!.height;
    for (const width of [900, 1500]) {
      await page.setViewportSize({ width, height: 900 });
      await expectFits(page, `with the warning at ${width}`);
      // The title is cut, not wrapped: the first row stays one control high.
      const row = (await page.locator('.top-row').boundingBox())!;
      expect(row.height, `row at ${width}`).toBeLessThanOrEqual(34);
    }
    const before = (await page.getByTestId('terminal').boundingBox())!;
    const tall = await headerHeight();
    await page.getByTestId('base-warning').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('base-warning')).toHaveCount(0);
    expect(await headerHeight()).toBeLessThan(tall);
    await expectFits(page, 'after the warning went');
    const after = (await page.getByTestId('terminal').boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height);
  } finally {
    await w.dispose();
  }
});
