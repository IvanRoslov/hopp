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

// The shell layer (projects, tasks, long-lived agents): one invoke channel per
// ShellBridge method, `shell:<method>`, and one event channel for store
// changes.
export const SHELL_METHODS = [
  'state', 'createProject', 'updateProject', 'removeProject', 'pickFolder', 'listProfiles',
  'createTask', 'stopTask', 'resumeTask', 'finishTask', 'hideTask',
  'createAgent', 'startAgent', 'stopAgent', 'removeAgent', 'agentMail', 'waiting',
  'listTools', 'toolUsage', 'setToolEnabled', 'toolRules', 'setToolRules', 'listLessons', 'closeLesson',
] as const;

export type ShellMethod = (typeof SHELL_METHODS)[number];

export const shellChannel = (m: ShellMethod): string => 'shell:' + m;

export const SHELL_CHANGED = 'shell:changed';
