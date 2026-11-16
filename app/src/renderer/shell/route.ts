// The page's routes. The left column and the work area render from one.
export type SettingsTab = 'projects' | 'models' | 'tools' | 'lessons';
export type Panel = 'questions' | 'details' | null;

export type Route =
  | { k: 'newTask'; project?: string }
  | { k: 'newProject' }
  | { k: 'project'; slug: string }
  | { k: 'task'; id: string; panel?: Panel; session?: string }
  | { k: 'agent'; name: string; panel?: Panel }
  | { k: 'newAgent' }
  | { k: 'settings'; tab: SettingsTab };

export type Go = (r: Route) => void;
