// registerIpc connects the page's bridge calls to the main-process services.
// Every channel is named; arguments are checked before use.
import { ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type { TerminalManager } from './terminal/manager';

export interface Services {
  terminals: TerminalManager;
}

const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new TypeError('expected a string');
  return v;
};
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('expected a number');
  return Math.floor(v);
};

export function registerIpc(s: Services): void {
  // Each terminal belongs to the page that opened it; its output goes only
  // there, and the page going away closes it.
  const owner = new Map<string, WebContents>();

  s.terminals.on('data', (id, data) => {
    const wc = owner.get(id);
    if (wc && !wc.isDestroyed()) wc.send(IPC.terminalData, id, data);
  });
  s.terminals.on('exit', (id, code) => {
    const wc = owner.get(id);
    owner.delete(id);
    if (wc && !wc.isDestroyed()) wc.send(IPC.terminalExit, id, code);
  });

  const tracked = new WeakSet<WebContents>();
  const track = (wc: WebContents) => {
    if (tracked.has(wc)) return;
    tracked.add(wc);
    const closeMine = () => {
      for (const [id, w] of owner) if (w === wc) s.terminals.close(id);
    };
    wc.once('destroyed', closeMine);
    // A reload replaces the page; its terminals go with the old page.
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) closeMine();
    });
  };

  ipcMain.handle(IPC.terminalOpen, async (e, sessionId: unknown, cols: unknown, rows: unknown) => {
    track(e.sender);
    const id = await s.terminals.open(str(sessionId), int(cols), int(rows));
    owner.set(id, e.sender);
    return id;
  });
  ipcMain.on(IPC.terminalWrite, (e, id: unknown, data: unknown) => {
    if (owner.get(str(id)) === e.sender) s.terminals.write(str(id), str(data));
  });
  ipcMain.on(IPC.terminalResize, (e, id: unknown, cols: unknown, rows: unknown) => {
    if (owner.get(str(id)) === e.sender) s.terminals.resize(str(id), int(cols), int(rows));
  });
  ipcMain.on(IPC.terminalClose, (e, id: unknown) => {
    if (owner.get(str(id)) === e.sender) s.terminals.close(str(id));
  });
}
