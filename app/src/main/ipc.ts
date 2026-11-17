// registerIpc connects the page's bridge calls to the main-process services.
// Every channel is named; arguments are checked before use.
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type { AskAnswer, QuizAnswer } from '../shared/types';
import { DaemonError, type DaemonClient } from './daemon/client';
import type { EventStream } from './daemon/stream';
import type { TerminalManager } from './terminal/manager';

export interface Services {
  client: DaemonClient;
  stream: EventStream;
  terminals: TerminalManager;
  startDaemon: () => Promise<{ ok: boolean; message: string }>;
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

const ASK_STATUSES = new Set(['open', 'answered', 'withdrawn', 'all']);

function askAnswer(v: unknown): AskAnswer {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: AskAnswer = {};
  if (typeof o['choice'] === 'string') out.choice = o['choice'];
  if (typeof o['answer'] === 'string') out.answer = o['answer'];
  return out;
}

function quizAnswer(v: unknown): QuizAnswer {
  const list = (v as { answers?: unknown })?.answers;
  if (!Array.isArray(list)) throw new TypeError('answers must be a list');
  return {
    answers: list.map((a) => {
      const o = a as Record<string, unknown>;
      const r: QuizAnswer['answers'][number] = { question_index: int(o['question_index']) };
      if (Array.isArray(o['option_indices'])) r.option_indices = o['option_indices'].map(int);
      if (typeof o['text'] === 'string') r.text = o['text'];
      return r;
    }),
  };
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
  s.stream.on('state', (st) => broadcast(IPC.daemonStateChanged, st));
  s.stream.on('event', (e) => broadcast(IPC.daemonEvent, e));

  ipcMain.handle(IPC.daemonSocketPath, () => s.client.socketPath);
  ipcMain.handle(IPC.daemonStreamState, () => s.stream.currentState ?? 'connecting');
  ipcMain.handle(IPC.daemonListSessions, (_e, opts: unknown) =>
    s.client.listSessions({ all: (opts as { all?: unknown } | undefined)?.all === true }),
  );
  ipcMain.handle(IPC.daemonGetSession, async (_e, id: unknown) => {
    try {
      return await s.client.getSession(str(id));
    } catch (err) {
      if (err instanceof DaemonError && err.status === 404) return null;
      throw err;
    }
  });
  ipcMain.handle(IPC.daemonStart, () => s.startDaemon());
  ipcMain.handle(IPC.daemonListAsks, (_e, opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>;
    const q: Parameters<DaemonClient['listAsks']>[0] = {};
    if (typeof o['from'] === 'string') q.from = o['from'];
    if (typeof o['status'] === 'string' && ASK_STATUSES.has(o['status'])) q.status = o['status'] as 'all';
    return s.client.listAsks(q);
  });
  ipcMain.handle(IPC.daemonAnswerAsk, (_e, id: unknown, body: unknown) => s.client.answerAsk(int(id), askAnswer(body)));
  ipcMain.handle(IPC.daemonDismissAsk, (_e, id: unknown) => s.client.dismissAsk(int(id)));
  ipcMain.handle(IPC.daemonAnswerQuiz, (_e, id: unknown, body: unknown) => s.client.answerQuiz(str(id), quizAnswer(body)));

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
