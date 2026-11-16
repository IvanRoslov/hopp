// Runs the real hopp CLI, built from daemon/ into a temp folder, against a
// temp HOPP_HOME, to prove the JSON the app reads is the JSON hopp prints.
// Skipped when Go is not installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '../daemon/client';
import { makeRunner } from './exec';
import { ShellService } from './service';
import { ShellStore } from './store';

const hasGo = spawnSync('go', ['version']).status === 0;

describe.skipIf(!hasGo)('the real hopp tools CLI', () => {
  let root: string;
  let home: string;
  let svc: ShellService;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hopp-tools-int-'));
    home = join(root, 'home');
    const bin = join(root, 'hopp');
    execFileSync('go', ['build', '-o', bin, './cmd/hopp'], { cwd: resolve(import.meta.dirname, '../../../../daemon'), stdio: 'ignore' });
    const tool = join(home, 'tools', 'fetcher');
    mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, 'tool.yaml'), 'name: fetcher\ndescription: Fetch a page\ncommand: [curl]\npaid: true\n');
    writeFileSync(join(tool, 'USAGE.md'), 'curl URL\n');
    const broken = join(home, 'tools', 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'tool.yaml'), 'name: broken\ncolour: red\n');
    writeFileSync(join(broken, 'USAGE.md'), 'x\n');
    const env = () => ({ ...process.env, HOPP_HOME: home, HOPP_SESSION_ID: '' });
    svc = new ShellService({
      home, store: new ShellStore(home), client: new DaemonClient(join(home, 'no.sock')),
      git: makeRunner('git', env), hopp: makeRunner(bin, env), pickFolder: async () => null,
    });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists tools and broken tools, shows usage, switches, and keeps rules', async () => {
    const c = await svc.listTools();
    expect(c.tools).toEqual([
      { name: 'fetcher', description: 'Fetch a page', via: 'command', command: ['curl'], mcp_server: '', harnesses: [], environment: [], paid: true, enabled: true, dir: join(home, 'tools', 'fetcher') },
    ]);
    expect(c.broken.map((b) => b.name)).toEqual(['broken']);
    expect(await svc.toolUsage('fetcher')).toBe('curl URL\n');
    expect((await svc.setToolEnabled('fetcher', false)).ok).toBe(true);
    expect((await svc.listTools()).tools[0]!.enabled).toBe(false);
    expect((await svc.setToolEnabled('ghost', true)).ok).toBe(false);
    expect(await svc.toolRules()).toEqual({ text: '', modifiedAt: 0 });
    const r = await svc.setToolRules('Video: X.');
    expect(r.ok && r.value.text).toBe('Video: X.\n');
    expect(r.ok && r.value.modifiedAt).toBeGreaterThan(0);
  });
});
