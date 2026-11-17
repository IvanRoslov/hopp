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
  'createAgent', 'startAgent', 'stopAgent', 'removeAgent', 'renameAgent', 'agentMail', 'waiting',
  'listTools', 'toolUsage', 'setToolEnabled', 'toolRules', 'setToolRules', 'listLessons', 'closeLesson',
  'setLessonAbout', 'setLessonProject', 'lessonToGuardrails', 'triageLessonsBrief',
  'createPipeline', 'updatePipeline', 'removePipeline', 'taskFeed', 'postToTask', 'answerSubmission', 'artifactText',
  'githubStatus', 'listGithubRepos', 'addGithubRepo',
  'setProfileEnabled', 'updateProfile', 'setDefaultProfile', 'removeProfile', 'moveProfile', 'modelCatalog', 'importModels',
] as const;

export type ShellMethod = (typeof SHELL_METHODS)[number];

export const shellChannel = (m: ShellMethod): string => 'shell:' + m;

export const SHELL_CHANGED = 'shell:changed';

// Sent with a task id when that task's feed changed.
export const SHELL_FEED_CHANGED = 'shell:feed-changed';

// Sent after a profile change made through this app.
export const SHELL_PROFILES_CHANGED = 'shell:profiles-changed';

// The scheme the page loads artifact files from: hopp-artifact://v/<id>.
// The id is in the path: a standard scheme parses a numeric host as an IPv4
// address, so hopp-artifact://12 would arrive as host 0.0.0.12.
export const ARTIFACT_SCHEME = 'hopp-artifact';
export const artifactUrl = (id: number): string => `${ARTIFACT_SCHEME}://v/${id}`;

// artifactIdOf reads the id back from such a URL; null when it is not one.
export function artifactIdOf(url: string): number | null {
  const m = /^hopp-artifact:\/\/v\/(\d+)\/?$/.exec(url);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
