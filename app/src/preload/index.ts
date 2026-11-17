import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { HoppBridge } from '../shared/bridge';
import type { ShellBridge } from '../shared/shell';
import { artifactUrl, IPC, SHELL_CHANGED, SHELL_FEED_CHANGED, SHELL_METHODS, SHELL_PROFILES_CHANGED, shellChannel } from '../shared/ipc';

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

// The shell bridge: each method invokes its own channel; onChanged listens
// for store changes.
const shellCalls = Object.fromEntries(
  SHELL_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(shellChannel(m), ...args)]),
) as unknown as Omit<ShellBridge, 'onChanged' | 'onFeedChanged' | 'onProfilesChanged' | 'artifactUrl'>;
const shell: ShellBridge = {
  ...shellCalls,
  onChanged: (cb) => listen(SHELL_CHANGED, cb),
  onFeedChanged: (cb) => listen(SHELL_FEED_CHANGED, cb),
  onProfilesChanged: (cb) => listen(SHELL_PROFILES_CHANGED, cb),
  artifactUrl: (id) => artifactUrl(id),
};

const bridge: HoppBridge = {
  daemon: {
    socketPath: () => ipcRenderer.invoke(IPC.daemonSocketPath),
    streamState: () => ipcRenderer.invoke(IPC.daemonStreamState),
    onStreamState: (cb) => listen(IPC.daemonStateChanged, cb),
    onEvent: (cb) => listen(IPC.daemonEvent, cb),
    listSessions: (opts) => ipcRenderer.invoke(IPC.daemonListSessions, opts),
    getSession: (id) => ipcRenderer.invoke(IPC.daemonGetSession, id),
    startDaemon: () => ipcRenderer.invoke(IPC.daemonStart),
    listAsks: (opts) => ipcRenderer.invoke(IPC.daemonListAsks, opts),
    answerAsk: (id, body) => ipcRenderer.invoke(IPC.daemonAnswerAsk, id, body),
    dismissAsk: (id) => ipcRenderer.invoke(IPC.daemonDismissAsk, id),
    answerQuiz: (id, body) => ipcRenderer.invoke(IPC.daemonAnswerQuiz, id, body),
  },
  terminal: {
    open: (sessionId, cols, rows) => ipcRenderer.invoke(IPC.terminalOpen, sessionId, cols, rows),
    write: (id, data) => ipcRenderer.send(IPC.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    close: (id) => ipcRenderer.send(IPC.terminalClose, id),
    onData: (cb) => listen<[string, string]>(IPC.terminalData, cb),
    onExit: (cb) => listen<[string, number]>(IPC.terminalExit, cb),
  },
  shell,
};

contextBridge.exposeInMainWorld('hopp', bridge);
