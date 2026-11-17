// The shell layer: projects, tasks and long-lived agents. The daemon knows
// none of this; the app keeps it in its own store and maps it onto daemon
// sessions. This file is the contract between the main process (which
// implements ShellBridge) and the page (which only calls it).

import type { Ask, Waiting } from './types';

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

// ---- pipelines ---------------------------------------------------------------

// A stage of a pipeline. `id` is stable: it survives renames and moves, and
// it is the value of the `hopp.stage` label on everything of that stage.
export interface PipelineStage {
  id: string;
  name: string;
  // "What the stage does".
  does: string;
  // "What the result looks like".
  result: string;
  // "May have substages".
  substages: boolean;
  // "Wait for approval": the stage is passed only after the human accepts it.
  approval: boolean;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  createdAt: number;
  updatedAt: number;
}

// A stage in a form: `id` omitted for a new stage, kept for an existing one.
export interface PipelineStageInput {
  id?: string;
  name: string;
  does: string;
  result: string;
  substages: boolean;
  approval: boolean;
}

export interface PipelineInput {
  name: string;
  stages: PipelineStageInput[];
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
  // A copy of the pipeline taken at launch; null for a task without one.
  // Later edits of the pipeline do not change it.
  pipeline: Pipeline | null;
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
  // Omitted or null: "No pipeline".
  pipelineId?: string | null;
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
  pipelines: Pipeline[];
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

// ---- the feed, stages and artifacts (daemon posts, asks and artifacts) -------

// Labels on everything of a task. `hopp.project` and `hopp.task` come from
// the task's sessions; the orchestrator adds the others.
export const LABEL = {
  project: 'hopp.project',
  task: 'hopp.task',
  role: 'hopp.role',
  stage: 'hopp.stage',
  substage: 'hopp.substage',
  substageTitle: 'hopp.substage_title',
  event: 'hopp.event',
  kind: 'hopp.kind',
} as const;

// Values of hopp.event and hopp.kind.
export const EVENT_STAGE_STARTED = 'stage_started';
export const EVENT_STAGE_DONE = 'stage_done';
export const KIND_SUBMISSION = 'submission';
export const KIND_PAID = 'paid';
// The options of a submission ask.
export const ACCEPT = 'Accept';
export const RETURN = 'Return';

// A post: a note in the feed. `from` is empty for the human's own line.
export interface Post {
  id: number;
  from: string;
  labels: Record<string, string>;
  body: string;
  // File paths, URLs, or artifact references `name@version`.
  attachments: string[];
  created_at: number;
}

// One stored, immutable version of an artifact.
export interface Artifact {
  id: number;
  scope: string;
  name: string;
  version: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  from: string;
  labels: Record<string, string>;
  created_at: number;
}

// Everything of one task the feed shows, oldest first: its posts and its asks
// (open and closed; submissions and paid asks are told apart by
// labels[LABEL.kind]), and every version of its artifacts.
export interface TaskFeed {
  posts: Post[];
  asks: Ask[];
  artifacts: Artifact[];
}

export type StageStatus = 'not_started' | 'started' | 'submitted' | 'accepted' | 'returned';

export interface SubstageState {
  slug: string;
  title: string;
}

// The derived state of one stage (see deriveStages in shared/stages.ts).
export interface StageState {
  stageId: string;
  status: StageStatus;
  substages: SubstageState[];
  // The open submission ask, when status is "submitted".
  submission: Ask | null;
  // The latest answered submission, for "returned" (its answer is what to fix).
  lastAnswer: Ask | null;
}

// The human's answer to a submission. Return needs the text of what to fix.
export type SubmissionAnswer = { choice: 'Accept' } | { choice: 'Return'; text: string };

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

  // Pipelines (kept by the app; in state().pipelines).
  createPipeline(input: PipelineInput): Promise<Result<Pipeline>>;
  updatePipeline(id: string, input: PipelineInput): Promise<Result<Pipeline>>;
  // Allowed any time: running tasks keep their own copy.
  removePipeline(id: string): Promise<Result<null>>;

  // The task's feed: posts, asks and artifacts labelled with its hopp.task.
  taskFeed(taskId: string): Promise<TaskFeed>;
  // Fires with the task id whenever a post, ask or artifact of that task
  // appears or changes; call taskFeed again to read it.
  onFeedChanged(cb: (taskId: string) => void): () => void;
  // The human's line: sent to the orchestrator as a message and recorded in
  // the feed as a post without `from`. stageId tags it with that stage. When
  // the message went out but the post could not be stored, the result is ok
  // with a post of id 0, so the human does not send it twice.
  postToTask(taskId: string, text: string, stageId?: string): Promise<Result<Post>>;
  // Accept or Return a submission ask.
  answerSubmission(askId: number, answer: SubmissionAnswer): Promise<Result<Ask>>;
  // A URL the page can load an artifact version from (img, video, iframe):
  // hopp-artifact://v/<id>. Served only from $HOPP_HOME/artifacts.
  artifactUrl(id: number): string;
  // The text of an artifact version, for the text viewer; refused for a file
  // over 2 MB or one that is not text.
  artifactText(id: number): Promise<Result<string>>;
}
