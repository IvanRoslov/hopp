// The page's routes. The left column and the work area render from one.
export type SettingsTab = 'projects' | 'models' | 'tools' | 'lessons';
export type Panel = 'questions' | 'details' | null;
// The right-hand panels of a task with a pipeline (see feed/PipelineTaskView).
export type PipelinePanel = 'stages' | 'artifacts' | 'terminal' | 'details';

export type Route =
  | { k: 'newTask'; project?: string; brief?: string }
  | { k: 'newProject' }
  | { k: 'project'; slug: string }
  | { k: 'task'; id: string; panel?: Panel; session?: string; pipelinePanel?: PipelinePanel | null; focusAskId?: number }
  | { k: 'agent'; name: string; panel?: Panel }
  | { k: 'newAgent' }
  | { k: 'pipelines'; id?: string }
  | { k: 'settings'; tab: SettingsTab };

export type Go = (r: Route) => void;
