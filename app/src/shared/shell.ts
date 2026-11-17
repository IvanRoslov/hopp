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

// TaskBase: the commit a task's worktree started from.
export interface TaskBase {
  // origin/<default branch> for a clone picked from GitHub; for a folder,
  // "HEAD (<branch>)".
  ref: string;
  commit: string;
  // Unix seconds of that commit.
  committedAt: number;
  // Whether the clone was fetched right before (false for a folder).
  fetched: boolean;
  // Why the fetch failed, so the start may be behind GitHub; empty otherwise.
  warning: string;
}

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
  // What the task's worktree started from; null for a folder without git
  // (and for tasks stored before this was recorded).
  base: TaskBase | null;
  // The session id of the agent that started the task (`hopp task new` run
  // inside a hopp session); null when the human started it.
  startedBy: string | null;
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
  // The session id of the agent starting the task (the CLI sets it from
  // $HOPP_SESSION_ID); omitted when the human starts it.
  startedBy?: string;
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
  // Whether this is the daemon's default profile (a launch without one).
  isDefault?: boolean;
}

// One model of a harness's catalog. `known`: a profile of that harness
// already uses this model.
export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  // A current model; false for older ones the harness still lists.
  main: boolean;
  efforts: string[];
  known: boolean;
}

export interface HarnessCatalog {
  agent: string;
  // Where the list came from (the harness, a cache, a built-in list).
  source: string;
  // Set when the harness is not installed or its list could not be read.
  warning: string;
  models: CatalogModel[];
}

export interface ProfileUpdate {
  description?: string;
  model?: string;
  effort?: string;
}

export interface ImportResult {
  // Profiles created, all switched off: the human switches on the ones to use.
  added: ModelProfile[];
  // Catalog models that already had a profile, or are not current models.
  skipped: number;
  // Harnesses whose catalog could not be read; the others are imported.
  failed: { agent: string; reason: string }[];
}

// ---- models-add: a profile the human adds, or copies with another effort ----
// (one block; addProfile and copyProfile are on the bridge below.)

// The harnesses hopp launches.
export const HARNESSES = ['claude-code', 'codex', 'kimi-code', 'pi', 'deepseek'] as const;

// The effort levels each harness accepts for a model its catalog does not
// list (the daemon's agent Efforts(), which also checks them on create).
export const HARNESS_EFFORTS: Record<string, string[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'kimi-code': ['low', 'high', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: ['low', 'medium', 'high', 'xhigh', 'max'],
};

export interface NewProfileInput {
  // Empty: the import naming for agent + model (+ effort), made unique.
  name?: string;
  agent: string;
  // A catalog model id or any id the harness takes.
  model: string;
  // '' or absent: the harness's default.
  effort?: string;
  description: string;
  // A profile the human adds is on unless said otherwise.
  enabled?: boolean;
}

export interface CopyProfileInput {
  // Empty: the source's name with the new effort (or "-copy"), made unique.
  name?: string;
  // Absent: the source's effort.
  effort?: string;
  description?: string;
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

// What a lesson is about (its `hopp.about` label); absent is unsorted.
export type LessonAbout = 'hopp' | 'project';

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
  // On a task's orchestrator: the agent session that started the task.
  startedBy: 'hopp.started_by',
  // On a lesson: what it is about (LessonAbout); absent is unsorted.
  about: 'hopp.about',
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

// The human's answer to a submission: one of the ask's options, exactly as
// written (see shared/submission.ts for which accept and which return). A
// return option needs the text of what to fix; any option may carry text.
export interface SubmissionAnswer {
  choice: string;
  text?: string;
}

// ---- GitHub repositories ---------------------------------------------------

// A repository the user can access on GitHub, through their own `gh` CLI.
export interface GithubRepo {
  // owner/repo
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  // ISO time of the last push.
  updatedAt: string;
  // Whether a managed clone of it exists in <HOPP_HOME>/repos.
  cloned: boolean;
}

export interface GithubStatus {
  available: boolean;
  // The gh login when available.
  login: string;
  // When not available: why, in a sentence.
  reason: string;
  // When not available: the one command that fixes it (`brew install gh`,
  // `gh auth login`); empty otherwise.
  command: string;
  // The hopp home, for managedRepoName(path, home) in shared/repos.ts.
  home: string;
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
  // Fires after any profile change made through this app.
  onProfilesChanged(cb: () => void): () => void;
  setProfileEnabled(name: string, enabled: boolean): Promise<Result<ModelProfile>>;
  updateProfile(name: string, update: ProfileUpdate): Promise<Result<ModelProfile>>;
  setDefaultProfile(name: string): Promise<Result<null>>;
  // Refused while a running session or an active task uses the profile.
  removeProfile(name: string): Promise<Result<null>>;
  // Moves a profile to position (0 = first) in the daemon's order.
  moveProfile(name: string, position: number): Promise<Result<null>>;
  // What each installed harness offers, with a mark for models that have a
  // profile already.
  modelCatalog(): Promise<Result<HarnessCatalog[]>>;
  // A switched-off profile for every current catalog model without one;
  // existing profiles are never changed.
  importModels(): Promise<Result<ImportResult>>;
  // models-add: a new profile; a refusal names its field (name, agent,
  // model, effort).
  addProfile(input: NewProfileInput): Promise<Result<ModelProfile>>;
  // A new profile with the same harness and model as `name`.
  copyProfile(name: string, input: CopyProfileInput): Promise<Result<ModelProfile>>;

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
  // Refused while the agent's session is running. Its mailbox goes with it
  // when it holds no letters; otherwise the mailbox stays.
  removeAgent(name: string): Promise<Result<null>>;
  // Renames an agent that is off, with the same checks as createAgent. The
  // new name gets a mailbox; the old mailbox is removed when it holds no
  // letters and stays, with its letters, otherwise (the daemon cannot move
  // them).
  renameAgent(name: string, newName: string): Promise<Result<LongAgent>>;
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
  // Sorts a lesson: about hopp, about a project, or back to unsorted (null).
  setLessonAbout(id: number, about: LessonAbout | null): Promise<Result<null>>;
  // The project a project lesson is about (its `hopp.project`), or none.
  setLessonProject(id: number, slug: string | null): Promise<Result<null>>;
  // Appends the lesson's text to its project's Guardrails as a bullet and
  // closes it.
  lessonToGuardrails(id: number): Promise<Result<null>>;
  // The brief of a task that works through a project's open lessons.
  triageLessonsBrief(projectSlug: string): Promise<string>;

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

  // GitHub, through the user's `gh` CLI; hopp stores no token.
  githubStatus(): Promise<GithubStatus>;
  // Repositories the user can access, most recently pushed first, filtered by
  // query (case-insensitive, on owner/repo and description).
  listGithubRepos(query: string): Promise<Result<GithubRepo[]>>;
  // Clones owner/repo into <HOPP_HOME>/repos/<owner>__<repo> unless it is
  // there already, and returns that path for the project's repositories.
  // See managedRepoName in shared/repos.ts to label such paths.
  addGithubRepo(fullName: string): Promise<Result<{ path: string }>>;
}
