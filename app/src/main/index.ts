import { app, BrowserWindow, session } from 'electron';
import { createWindow } from './window';

app.whenReady().then(() => {
  // No remote content: refuse every permission request from the page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
