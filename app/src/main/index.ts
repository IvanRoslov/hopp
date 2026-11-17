import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import { ARTIFACT_SCHEME, artifactIdOf, SHELL_FEED_CHANGED } from '../shared/ipc';
import { DaemonClient, resolveHoppHome, resolveSocketPath } from './daemon/client';
import { startDaemon } from './daemon/start';
import { EventStream } from './daemon/stream';
import { registerIpc } from './ipc';
import { makeRunner } from './shell/exec';
import { registerShellIpc } from './shell/ipc';
import { ShellService } from './shell/service';
import { ShellStore } from './shell/store';
import { loginShellPath, mergePath } from './shellEnv';
import { resolveExecutable } from './terminal/manager';
import { TerminalManager } from './terminal/manager';
import { createWindow } from './window';

// Artifacts load in the page from hopp-artifact://<id> (img, video, iframe).
protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const hoppHome = resolveHoppHome(process.env);

// One app per hopp home: a second launch focuses the first window instead of
// running a second process that would overwrite the first one's store. With
// an explicit HOPP_HOME (tests, a second home) the app keeps its own data
// there, so it locks per home and never collides with the everyday app.
if (process.env['HOPP_HOME']) app.setPath('userData', join(hoppHome, 'app-data'));
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});
const socketPath = resolveSocketPath(process.env);
const client = new DaemonClient(socketPath);

// The PATH of the user's login shell, read once in the background. Starting
// the daemon and opening a terminal wait for it, so both see the same tools
// the user's own terminal does; the window does not wait.
const envReady = loginShellPath(process.env['SHELL'] || '/bin/zsh').then((p) => {
  process.env['PATH'] = mergePath(process.env['PATH'], p);
});

const terminals = new TerminalManager({
  attachCommand: async (id) => {
    await envReady;
    return client.attachCommand(id);
  },
});
const stream = new EventStream(socketPath);

// The shell layer runs git and the hopp CLI with the login shell's PATH and
// this app's HOPP_HOME, so `hopp tools` reads the same catalog the daemon's
// sessions do.
const childEnv = () => ({ ...process.env, HOPP_HOME: hoppHome });
const gitRunner = makeRunner('git', childEnv);
const hoppRunner = makeRunner(() => resolveExecutable('hopp', process.env) ?? null, childEnv);
const afterEnv = (r: typeof gitRunner): typeof gitRunner => async (args, opts) => {
  await envReady;
  return r(args, opts);
};
const shellService = new ShellService({
  home: hoppHome,
  store: new ShellStore(hoppHome),
  client,
  git: afterEnv(gitRunner),
  hopp: afterEnv(hoppRunner),
  pickFolder: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
  },
});

app.whenReady().then(() => {
  if (!primary) return;
  // No remote content: refuse every permission request from the page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc({
    client,
    stream,
    terminals,
    startDaemon: async () => {
      await envReady;
      return startDaemon(process.env);
    },
  });
  const send = (channel: string, ...args: unknown[]) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
    }
  };
  registerShellIpc(ipcMain, shellService, send);
  stream.on('event', (e) => {
    const task = shellService.feedTaskOf(e);
    if (task) send(SHELL_FEED_CHANGED, task);
  });
  void shellService.seedPipelines().catch((err) => console.error('hopp: could not add the starter pipelines:', err));
  // Only files inside $HOPP_HOME/artifacts are served; anything else is 404.
  protocol.handle(ARTIFACT_SCHEME, async (req) => {
    const id = artifactIdOf(req.url);
    if (id === null) return new Response('not found', { status: 404 });
    try {
      const f = await shellService.artifactFile(id);
      const r = await net.fetch(pathToFileURL(f.path).toString(), { headers: req.headers });
      const headers = new Headers(r.headers);
      headers.set('Content-Type', f.mime);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Content-Security-Policy', "default-src 'none'; img-src hopp-artifact: data:; media-src hopp-artifact:; style-src 'unsafe-inline'; sandbox");
      return new Response(r.body, { status: r.status, headers });
    } catch (err) {
      console.warn(`hopp: artifact ${id} not served: ${(err as Error).message}`);
      return new Response('not found', { status: 404 });
    }
  });
  stream.start();
  const open = () => {
    const win = createWindow();
    // Closing the window detaches every terminal it had open.
    win.on('closed', () => terminals.closeAll());
  };
  open();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) open();
  });
});

// Quitting detaches too: tmux sessions keep running.
app.on('before-quit', () => {
  stream.stop();
  terminals.closeAll();
});
app.on('window-all-closed', () => app.quit());
