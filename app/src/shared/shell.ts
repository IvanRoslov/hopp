// The shell layer: projects, tasks and long-lived agents. The daemon knows
// none of this; the app keeps it in its own store and maps it onto daemon
// sessions. This file is the contract between the main process (which
// implements ShellBridge) and the page (which only calls it).

import type { Waiting } from './types';

// ---- results ---------------------------------------------------------------

// A failed operation the page shows to the human. `field` names the form
// field the message belongs next to, when there is one.
export interface ShellError {
  code: string;
  message: string;
  field?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ShellError };

// ---- entities --------------------------------------------------------------

export interface Project {
  slug: string;
  name: string;
  description: string;
  // The repository the orchestrator's worktree is made from. null: the
  // project has no repository and tasks run in a plain folder.
  orchestratorRepo: string | null;
  // Repositories the orchestrator may launch workers in. Empty: workers run
  // in the orchestrator's repository.
  workerRepos: string[];
  // Free text every orchestrator of this project gets at start.
  guardrails: string;
  createdAt: number;
}

export interface ProjectInput {
  name: string;
  // Omitted: derived from name with slugify().
  slug?: string;
  description: string;
  orchestratorRepo: string | null;
  workerRepos: string[];
  guardrails: string;
}

export type TaskStatus = 'active' | 'finished';

export interface Task {
  id: string;
  projectSlug: string;
  title: string;
  // What the human asked for; sent to the orchestrator as its first message.
  brief: string;
  // The orchestrator's daemon session; the task's other sessions are its
  // descendants.
  sessionId: string;
  dir: string;
  // The git branch of the task's worktree; null when the project has no
  // repository.
  branch: string | null;
  orchestratorProfile: string;
  workerProfiles: string[];
  status: TaskStatus;
  // Removed from the list by the human; kept in the store.
  hidden: boolean;
  createdAt: number;
  finishedAt: number;
}

export interface TaskInput {
  projectSlug: string;
  brief: string;
  // Omitted: the first line of the brief, cut to 60 characters.
  title?: string;
  orchestratorProfile: string;
  workerProfiles: string[];
  // "More" section of the form.
  sessionName?: string;
  extraSystemPrompt?: string;
}

// A long-lived agent: stands above projects, runs in its own folder where
// its context lives. `name` is also its session id and its mailbox name.
export interface LongAgent {
  name: string;
  profile: string;
  dir: string;
  createdAt: number;
}

export interface LongAgentInput {
  name: string;
  profile: string;
  dir: string;
}

export interface ShellState {
  projects: Project[];
  tasks: Task[];
  agents: LongAgent[];
}

// ---- read-only data from the daemon and the tools catalog -------------------

export interface ModelProfile {
  name: string;
  agent: string;
  model: string;
  effort: string;
  description: string;
  enabled: boolean;
  position: number;
}

export interface Tool {
  name: string;
  description: string;
  via: 'command' | 'mcp' | 'guide';
  command: string[];
  mcp_server: string;
  harnesses: string[];
  environment: string[];
  paid: boolean;
  enabled: boolean;
  dir: string;
}

export interface ToolCatalog {
  tools: Tool[];
  broken: { name: string; error: string }[];
}

export interface ToolRules {
  text: string;
  // Unix seconds; 0 when the rules file does not exist.
  modifiedAt: number;
}

export interface Lesson {
  id: number;
  from: string;
  labels: Record<string, string>;
  body: string;
  status: 'new' | 'closed';
  created_at: number;
  closed_at: number;
}

// ---- the bridge -------------------------------------------------------------

export interface ShellBridge {
  state(): Promise<ShellState>;
  // Fires after every change of the store, with the new state.
  onChanged(cb: (s: ShellState) => void): () => void;

  createProject(input: ProjectInput): Promise<Result<Project>>;
  updateProject(slug: string, input: ProjectInput): Promise<Result<Project>>;
  // Refused while the project has tasks that are not hidden.
  removeProject(slug: string): Promise<Result<null>>;
  // Opens the native folder dialog; null when cancelled.
  pickFolder(): Promise<string | null>;

  // Enabled profiles first, in the daemon's order.
  listProfiles(): Promise<ModelProfile[]>;

  // Makes the worktree (or folder), composes the start text and launches the
  // orchestrator's session.
  createTask(input: TaskInput): Promise<Result<Task>>;
  // Stops the orchestrator and every descendant session. The task stays
  // active and can be resumed.
  stopTask(id: string): Promise<Result<null>>;
  // Restores the orchestrator's session after a stop.
  resumeTask(id: string): Promise<Result<null>>;
  // Stops everything and moves the task to Recent.
  finishTask(id: string): Promise<Result<null>>;
  hideTask(id: string): Promise<Result<null>>;

  createAgent(input: LongAgentInput): Promise<Result<LongAgent>>;
  // Launches the agent's session in its folder (restores it if it ran before).
  startAgent(name: string): Promise<Result<null>>;
  stopAgent(name: string): Promise<Result<null>>;
  // Refused while the agent's session is running.
  removeAgent(name: string): Promise<Result<null>>;
  // Unread mail per agent name, for agents that are switched off.
  agentMail(): Promise<Record<string, number>>;

  // Everything that waits for the human: open asks and harness questions.
  waiting(): Promise<Waiting>;

  listTools(): Promise<ToolCatalog>;
  // The tool's USAGE.md.
  toolUsage(name: string): Promise<string>;
  setToolEnabled(name: string, enabled: boolean): Promise<Result<null>>;
  toolRules(): Promise<ToolRules>;
  setToolRules(text: string): Promise<Result<ToolRules>>;

  listLessons(status: 'new' | 'closed' | 'all'): Promise<Lesson[]>;
  closeLesson(id: number): Promise<Result<null>>;
}
