import { expect, test } from '@playwright/test';
import { FakeDaemon, makeSession } from '../test/fakeDaemon';
import { launchApp } from './launch';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('terminal output reaches the page; closing the app ends the pty', async () => {
  const d = new FakeDaemon();
  await d.start();
  d.sessions = [makeSession('s1')];
  d.defaultAttach = ['/bin/sh', '-c', 'echo hello pid=$$; exec cat'];
  const app = await launchApp({ HOPP_HOME: d.home });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const w = window as any;
      w.__out = '';
      w.hopp.terminal.onData((_id: string, data: string) => (w.__out += data));
      w.__id = await w.hopp.terminal.open('s1', 80, 24);
    });
    await expect.poll(() => page.evaluate(() => (window as any).__out)).toContain('hello pid=');
    const out: string = await page.evaluate(() => (window as any).__out);
    const pid = Number(/pid=(\d+)/.exec(out)![1]);
    await page.evaluate(() => {
      const w = window as any;
      w.hopp.terminal.write(w.__id, 'echoed-back\r');
    });
    await expect.poll(() => page.evaluate(() => (window as any).__out)).toContain('echoed-back');
    expect(alive(pid)).toBe(true);
    await app.close();
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
  } finally {
    await app.close().catch(() => {});
    await d.dispose();
  }
});
