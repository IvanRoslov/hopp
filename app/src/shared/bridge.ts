// The API the preload bridge exposes to the page as `window.hopp`.
// Named functions only: the page never sees ipcRenderer or Node.

import type { Ask, AskAnswer, DaemonEvent, QuizAnswer, Session, StreamState } from './types';

export type Unsubscribe = () => void;

export interface DaemonBridge {
  // socketPath is the socket the app tries, shown when the daemon is down.
  socketPath(): Promise<string>;
  streamState(): Promise<StreamState>;
  onStreamState(cb: (s: StreamState) => void): Unsubscribe;
  onEvent(cb: (e: DaemonEvent) => void): Unsubscribe;
  listSessions(opts?: { all?: boolean }): Promise<Session[]>;
  // getSession resolves to null when the daemon has no such session.
  getSession(id: string): Promise<Session | null>;
  // startDaemon runs `hopp daemon start` with the hopp found on PATH.
  startDaemon(): Promise<{ ok: boolean; message: string }>;
  listAsks(opts?: { from?: string; status?: 'open' | 'answered' | 'withdrawn' | 'all' }): Promise<Ask[]>;
  answerAsk(id: number, body: AskAnswer): Promise<Ask>;
  answerQuiz(sessionId: string, body: QuizAnswer): Promise<{ status: string }>;
}

export interface TerminalBridge {
  // open attaches to a session in a new pty; resolves to the terminal's id.
  open(sessionId: string, cols: number, rows: number): Promise<string>;
  write(termId: string, data: string): void;
  resize(termId: string, cols: number, rows: number): void;
  // close detaches (hangs up the tmux client); the session keeps running.
  close(termId: string): void;
  onData(cb: (termId: string, data: string) => void): Unsubscribe;
  onExit(cb: (termId: string, code: number) => void): Unsubscribe;
}

export interface HoppBridge {
  daemon: DaemonBridge;
  terminal: TerminalBridge;
}

declare global {
  interface Window {
    hopp: HoppBridge;
  }
}
