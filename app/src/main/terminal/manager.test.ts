import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalManager } from './manager';

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A stand-in for the daemon: attachCommand returns whatever the test set.
class FakeAttach {
  commands: Record<string, string[]> = {};
  attachCommand = async (id: string) => {
    const c = this.commands[id];
    if (!c) throw new Error('session not found: ' + id);
    return c;
  };
}

describe('TerminalManager', () => {
  let a: FakeAttach;
  let m: TerminalManager;
  let out: Record<string, string>;
  let exits: Record<string, number>;

  beforeEach(() => {
    a = new FakeAttach();
    m = new TerminalManager(a);
    out = {};
    exits = {};
    m.on('data', (id, d) => (out[id] = (out[id] ?? '') + d));
    m.on('exit', (id, code) => (exits[id] = code));
  });
  afterEach(() => m.closeAll());

  it('runs the attach command in a pty and streams its output', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'echo hello; cat'];
    const t = await m.open('s', 80, 24);
    await until(() => (out[t] ?? '').includes('hello'));
  });

  it('echoes input back', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'echo ready; cat'];
    const t = await m.open('s', 80, 24);
    await until(() => (out[t] ?? '').includes('ready'));
    m.write(t, 'typed-text\r');
    await until(() => (out[t] ?? '').includes('typed-text'));
  });

  it('close ends the child process', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'echo pid=$$; exec cat'];
    const t = await m.open('s', 80, 24);
    await until(() => /pid=\d+/.test(out[t] ?? ''));
    const pid = Number(/pid=(\d+)/.exec(out[t]!)![1]);
    expect(alive(pid)).toBe(true);
    m.close(t);
    await until(() => !alive(pid));
    expect(m.openCount).toBe(0);
  });

  it('a command that exits at once produces exit', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'exit 3'];
    const t = await m.open('s', 80, 24);
    await until(() => t in exits);
    expect(exits[t]).toBe(3);
    expect(m.openCount).toBe(0);
    // Writing to or resizing an ended terminal is a no-op, not a crash.
    m.write(t, 'x');
    m.resize(t, 100, 30);
    m.close(t);
  });

  it('removes TMUX from the child environment and sets TERM', async () => {
    const saved = process.env['TMUX'];
    process.env['TMUX'] = '/tmp/someone-elses-tmux,1,0';
    try {
      a.commands['s'] = ['/bin/sh', '-c', 'echo "tmux=[$TMUX] pane=[$TMUX_PANE] term=$TERM"; cat'];
      const t = await m.open('s', 80, 24);
      await until(() => (out[t] ?? '').includes('term='));
      expect(out[t]).toContain('tmux=[] pane=[] term=xterm-256color');
    } finally {
      if (saved === undefined) delete process.env['TMUX'];
      else process.env['TMUX'] = saved;
    }
  });

  it('resize changes the pty size', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'stty size; read x; stty size; cat'];
    const t = await m.open('s', 80, 24);
    await until(() => (out[t] ?? '').includes('24 80'));
    m.resize(t, 100, 30);
    m.write(t, '\r');
    await until(() => (out[t] ?? '').includes('30 100'));
  });

  it('open fails when the daemon has no attach command', async () => {
    await expect(m.open('missing', 80, 24)).rejects.toThrow(/session not found/);
    expect(m.openCount).toBe(0);
  });

  it('closeAll closes every terminal', async () => {
    a.commands['s'] = ['/bin/sh', '-c', 'echo pid=$$; exec cat'];
    const t1 = await m.open('s', 80, 24);
    const t2 = await m.open('s', 80, 24);
    await until(() => /pid=\d+/.test(out[t1] ?? '') && /pid=\d+/.test(out[t2] ?? ''));
    const pids = [t1, t2].map((t) => Number(/pid=(\d+)/.exec(out[t]!)![1]));
    m.closeAll();
    await until(() => pids.every((p) => !alive(p)));
  });
});

// Review Focus 3: closing the terminal detaches the tmux client and the tmux
// session stays. Runs on a private tmux server (-L), never the user's.
describe('TerminalManager with tmux', () => {
  const sock = `hopp-app-test-${process.pid}`;
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', sock, '-f', '/dev/null', ...args], { encoding: 'utf8' });

  let socketPath = '';
  afterEach(() => {
    try {
      tmux('kill-server');
    } catch {
      // already gone
    }
    // tmux leaves its socket file behind; remove this test's own.
    if (socketPath.includes(sock)) rmSync(socketPath, { force: true });
  });

  it('close detaches and leaves the session running', async () => {
    tmux('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24', 'sh -c "echo inside-tmux; sleep 600"');
    socketPath = tmux('display-message', '-p', '-t', '=probe', '#{socket_path}').trim();
    const a = new FakeAttach();
    a.commands['probe'] = ['tmux', '-L', sock, 'attach', '-t', '=probe'];
    const m = new TerminalManager(a);
    let out = '';
    let exited = false;
    m.on('data', (_id, d) => (out += d));
    m.on('exit', () => (exited = true));
    const t = await m.open('probe', 80, 24);
    await until(() => out.includes('inside-tmux'));
    expect(tmux('list-clients', '-t', '=probe').trim()).not.toBe('');
    m.close(t);
    await until(() => exited);
    await until(() => tmux('list-clients', '-t', '=probe').trim() === '');
    // The session is still there and its program still runs.
    expect(tmux('has-session', '-t', '=probe')).toBe('');
    expect(tmux('list-panes', '-t', '=probe', '-F', '#{pane_dead}').trim()).toBe('0');
  });
});
