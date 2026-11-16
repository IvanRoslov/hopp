import type { Session } from '../../shared/types';

// isEnded: the session is no longer live (its agent exited or it was killed).
export function isEnded(s: Session): boolean {
  return s.state !== 'running' && s.state !== 'spawning';
}

// stateWord turns the daemon's state and activity into one word for the list.
export function stateWord(s: Session): string {
  if (s.state === 'errored') return 'errored';
  if (isEnded(s) || s.activity === 'exited') return 'exited';
  if (s.state === 'spawning') return 'starting';
  if (s.question || s.activity === 'waiting_input' || s.activity === 'blocked') return 'waiting for input';
  if (s.activity === 'active') return 'working';
  return 'idle';
}

export interface TreeNode {
  session: Session;
  children: TreeNode[];
}

const byAge = (a: Session, b: Session) => a.created_at - b.created_at || a.id.localeCompare(b.id);

// buildTree nests sessions under their parents. A session whose parent is
// not shown sits at the top level.
export function buildTree(sessions: Session[], showEnded: boolean): TreeNode[] {
  const shown = sessions.filter((s) => showEnded || !isEnded(s)).sort(byAge);
  const nodes = new Map(shown.map((s) => [s.id, { session: s, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const s of shown) {
    const n = nodes.get(s.id)!;
    const p = s.parent ? nodes.get(s.parent) : undefined;
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  return roots;
}
