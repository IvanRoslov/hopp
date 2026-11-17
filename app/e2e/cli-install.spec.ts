import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDaemon } from '../test/fakeDaemon';
import { appDir, launchApp } from './launch';

// The app installs its commands only when the CLI bundle exists. `npm run
// test:e2e` builds it; a direct `npx playwright test` after only
// `electron-vite build` may not have it, so build it here (it takes well
// under a second). This spec checks the scripts, not what the bundle does,
// so a stale bundle does not matter to it.
test.beforeAll(() => {
  const bundle = join(appDir, 'out', 'cli', 'hopp-shell.cjs');
  if (existsSync(bundle)) return;
  try {
    execFileSync('npx', ['vite', 'build', '-c', 'cli.vite.config.ts', '--logLevel', 'error'], { cwd: appDir, stdio: 'pipe' });
  } catch (err) {
    throw new Error(`${bundle} is missing and building it failed; run \`npm run build\` in app/: ${(err as Error).message}`);
  }
});

test('the app installs its commands into $HOPP_HOME/bin at start', async () => {
  const d = new FakeDaemon();
  await d.start();
  const app = await launchApp({ HOPP_HOME: d.home });
  await app.firstWindow();
  const script = join(d.home, 'bin', 'hopp-task');
  await expect.poll(() => existsSync(script)).toBe(true);
  const text = readFileSync(script, 'utf8');
  expect(text).toContain(`'${join(appDir, 'out', 'cli', 'hopp-shell.cjs')}' task "$@"`);
  expect(text).toContain('ELECTRON_RUN_AS_NODE=1 exec ');
  for (const n of ['project', 'pipeline']) expect(existsSync(join(d.home, 'bin', 'hopp-' + n))).toBe(true);
  await app.close();
  await d.dispose();
});
