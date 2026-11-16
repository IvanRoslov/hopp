// The API the preload bridge exposes to the page as `window.hopp`.
// Named functions only: the page never sees ipcRenderer or Node.

export type Unsubscribe = () => void;

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
  terminal: TerminalBridge;
}

declare global {
  interface Window {
    hopp: HoppBridge;
  }
}
