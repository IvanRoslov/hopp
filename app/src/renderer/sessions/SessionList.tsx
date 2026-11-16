import { useMemo } from 'react';
import type { Session } from '../../shared/types';
import { buildTree, stateWord, type TreeNode } from './model';

export function SessionList(props: {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showEnded: boolean;
  onShowEnded: (v: boolean) => void;
}) {
  const tree = useMemo(() => buildTree(props.sessions, props.showEnded), [props.sessions, props.showEnded]);
  const rows: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  return (
    <div className="sessions">
      <div className="sessions-head">
        <span>Sessions</span>
        <label>
          <input type="checkbox" checked={props.showEnded} onChange={(e) => props.onShowEnded(e.target.checked)} />
          Show ended
        </label>
      </div>
      {rows.length === 0 && <div className="sessions-empty">No sessions</div>}
      <ul className="sessions-list">
        {rows.map(({ node, depth }) => {
          const s = node.session;
          const word = stateWord(s);
          return (
            <li
              key={s.id}
              data-testid="session-row"
              data-id={s.id}
              data-depth={depth}
              className={'session-row' + (s.id === props.selectedId ? ' selected' : '')}
              style={{ paddingLeft: `calc(var(--gap) + ${depth} * var(--indent))` }}
              onClick={() => props.onSelect(s.id)}
            >
              <span className="session-id">{s.id}</span>
              <span className={'session-state state-' + word.replace(/ /g, '-')}>{word}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
