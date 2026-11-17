import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron';
import { ARTIFACT_SCHEME, artifactIdOf, SHELL_FEED_CHANGED } from '../shared/ipc';
import { DaemonClient, resolveHoppHome, resolveSocketPath } from './daemon/client';
import { startDaemon } from './daemon/start';
import { EventStream } from './daemon/stream';
import { installCommands, installLine } from './cliInstall';
import { registerIpc } from './ipc';
import { makeRunner } from './shell/exec';
import { registerShellIpc } from './shell/ipc';
import { serveShell, shellSocketPath, type ShellServer } from './shell/server';
import { ShellService } from './shell/service';
import { ShellStore } from './shell/store';
import { ensureUtf8Locale, loginShellPath, mergePath, readPathCache, writePathCache } from './shellEnv';
import { resolveExecutable } from './terminal/manager';
import { TerminalManager } from './terminal/manager';
import { createWindow } from './window';

// Artifacts load in the page from hopp-artifact://<id> (img, video, iframe).
protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Before anything is spawned: the terminal, the daemon and git inherit it.
ensureUtf8Locale(process.env);

const hoppHome = resolveHoppHome(process.env);
// HOPP_APP_HOME keeps the app's own store (and its single-instance lock) apart
// from the hopp home whose daemon, worktrees, tools and artifacts it uses, so
// a second app can work against a live daemon without touching the store of
// the app that is already open on it. Default: the hopp home.
const appHome = process.env['HOPP_APP_HOME'] || hoppHome;

// One app per hopp home: a second launch focuses the first window instead of
// running a second process that would overwrite the first one's store. With
// an explicit HOPP_HOME (tests, a second home) the app keeps its own data
// there, so it locks per home and never collides with the everyday app.
if (process.env['HOPP_HOME'] || process.env['HOPP_APP_HOME']) app.setPath('userData', join(appHome, 'app-data'));
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
const pathCache = join(appHome, 'login-path');
const cachedPath = readPathCache(pathCache);
if (cachedPath) process.env['PATH'] = mergePath(process.env['PATH'], cachedPath);
const freshPath = loginShellPath(process.env['SHELL'] || '/bin/zsh').then((p) => {
  if (!p) return;
  process.env['PATH'] = mergePath(process.env['PATH'], p);
  writePathCache(pathCache, p);
});
// With a remembered PATH nothing waits for the shell; without one (the first
// start) the daemon and the terminal wait until the shell has answered.
const envReady: Promise<void> = cachedPath ? Promise.resolve() : freshPath;

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
// gh clones can take long: their runner has a 30 minute bound.
const ghRunner = makeRunner(() => resolveExecutable('gh', process.env) ?? null, childEnv, 30 * 60_000);
const afterEnv = (r: typeof gitRunner): typeof gitRunner => async (args, opts) => {
  await envReady;
  return r(args, opts);
};
const shellStore = new ShellStore(appHome);
const shellService = new ShellService({
  home: hoppHome,
  store: shellStore,
  client,
  git: afterEnv(gitRunner),
  hopp: afterEnv(hoppRunner),
  gh: afterEnv(ghRunner),
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
  // `hopp task …` and the other commands of the app run here while the app
  // is open; a change one of them made while the app was closed (or racing
  // its start) is picked up by the watcher.
  stopWatching = shellStore.watch();
  serveShell(shellService, shellSocketPath(appHome)).then(
    (s) => {
      shellServer = s;
    },
    (err) => console.error('hopp: the shell socket for `hopp task` is not served:', (err as Error).message),
  );
  stream.on('event', (e) => {
    const task = shellService.feedTaskOf(e);
    if (task) send(SHELL_FEED_CHANGED, task);
  });
  // The commands `hopp project|pipeline|task`, refreshed at every start so
  // they run this app; never a reason not to start.
  const bundle = app.isPackaged ? join(process.resourcesPath, 'hopp-shell.cjs') : join(app.getAppPath(), 'out', 'cli', 'hopp-shell.cjs');
  installCommands(join(hoppHome, 'bin'), process.execPath, bundle).then(
    (r) => console.log(installLine(r)),
    (err) => console.warn(`hopp: the commands hopp project, pipeline and task were not installed: ${(err as Error).message}`),
  );
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

let shellServer: ShellServer | null = null;
let stopWatching: (() => void) | null = null;

// Quitting detaches too: tmux sessions keep running.
app.on('before-quit', () => {
  stopWatching?.();
  void shellServer?.close();
  stream.stop();
  terminals.closeAll();
});
app.on('window-all-closed', () => app.quit());
