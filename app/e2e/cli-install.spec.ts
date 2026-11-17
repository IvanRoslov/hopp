import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDaemon } from '../test/fakeDaemon';
import { appDir, launchApp } from './launch';

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
