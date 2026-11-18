import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

// createWindow opens the app window with the renderer locked down: no Node in
// the page, an isolated preload, the Chromium sandbox, and no navigation or
// new windows (the page loads only its own bundle).
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'hopp',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Links open in the system browser, never inside the app.
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // An HTML artifact runs its scripts in a frame; the frame may move only
  // between artifacts, so a script cannot carry data out by navigating.
  win.webContents.on('will-frame-navigate', (e) => {
    if (!e.url.startsWith('hopp-artifact:')) e.preventDefault();
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}
