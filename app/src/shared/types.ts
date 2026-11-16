// JSON shapes of the hopp daemon API (daemon/internal/api). Shared by the
// main process, the bridge and the page.

export interface QuizOption {
  label: string;
  description?: string;
}

export interface QuizQuestion {
  question: string;
  header: string;
  multi_select: boolean;
  options: QuizOption[];
}

// The question a session waits on: an AskUserQuestion quiz, or a permission
// dialog (source "permission", raw = the dialog's pane tail).
export interface SessionQuestion {
  questions: QuizQuestion[];
  asked_at: number;
  source?: string;
  raw?: string;
}

export interface Session {
  id: string;
  parent: string;
  dir: string;
  labels: Record<string, string>;
  spawn_dirs: string[];
  agent: string;
  profile: string;
  model: string;
  effort: string;
  state: string;
  activity: string;
  created_at: number;
  updated_at: number;
  children?: string[];
  question?: SessionQuestion;
}

export interface Ask {
  id: number;
  from: string;
  labels: Record<string, string> | null;
  body: string;
  options: string[] | null;
  attachments: string[] | null;
  status: 'open' | 'answered' | 'withdrawn' | string;
  choice?: string;
  answer?: string;
  reason?: string;
  created_at: number;
  closed_at?: number;
}

export interface Health {
  status: string;
  pid: number;
  version: string;
  started_at: number;
}

export interface Waiting {
  asks: Ask[];
  questions: { session: string; question: SessionQuestion }[];
}

export interface DaemonEvent {
  id: number;
  ts: number;
  type: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

export interface AskAnswer {
  choice?: string;
  answer?: string;
}

export interface QuizAnswer {
  answers: { question_index: number; option_indices?: number[]; text?: string }[];
}

export type StreamState = 'connecting' | 'open' | 'down';
