// IPC channel names shared by the main process and the preload bridge.
export const IPC = {
  daemonSocketPath: 'daemon:socket-path',
  daemonStreamState: 'daemon:stream-state',
  daemonStateChanged: 'daemon:state-changed',
  daemonEvent: 'daemon:event',
  daemonListSessions: 'daemon:list-sessions',
  daemonGetSession: 'daemon:get-session',
  daemonStart: 'daemon:start',
  daemonListAsks: 'daemon:list-asks',
  daemonAnswerAsk: 'daemon:answer-ask',
  daemonAnswerQuiz: 'daemon:answer-quiz',
  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
} as const;
