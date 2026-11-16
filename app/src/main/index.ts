import { app, BrowserWindow, session } from 'electron';
import { DaemonClient, resolveSocketPath } from './daemon/client';
import { startDaemon } from './daemon/start';
import { EventStream } from './daemon/stream';
import { registerIpc } from './ipc';
import { TerminalManager } from './terminal/manager';
import { createWindow } from './window';

const socketPath = resolveSocketPath(process.env);
const client = new DaemonClient(socketPath);
const terminals = new TerminalManager(client);
const stream = new EventStream(socketPath);

app.whenReady().then(() => {
  // No remote content: refuse every permission request from the page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc({ client, stream, terminals, startDaemon: () => startDaemon(process.env) });
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
