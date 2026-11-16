import type { ReactNode } from 'react';

// Frame is the screen's three zones: the session list on the left, the
// optional questions column in the middle, the terminal on the right.
export function Frame(props: { header?: ReactNode; left: ReactNode; middle: ReactNode | null; right: ReactNode }) {
  return (
    <div className="frame">
      <aside className="frame-left" data-testid="zone-left">{props.left}</aside>
      {props.middle !== null && (
        <section className="frame-middle" data-testid="zone-middle">{props.middle}</section>
      )}
      <main className="frame-right" data-testid="zone-right">
        {props.header && <header className="frame-header">{props.header}</header>}
        <div className="frame-right-body">{props.right}</div>
      </main>
    </div>
  );
}
