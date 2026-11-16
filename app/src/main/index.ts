import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
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

const hoppHome = resolveHoppHome(process.env);
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
  registerShellIpc(ipcMain, shellService, (channel, ...args) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
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
