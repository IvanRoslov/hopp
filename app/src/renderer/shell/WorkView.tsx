import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HoppBridge } from '../../shared/bridge';
import type { Session, StreamState } from '../../shared/types';
import { sessionWord } from '../model/shellModel';
import { QuestionsPanel } from '../questions/Panel';
import { useAsks } from '../questions/useAsks';
import { Terminal } from '../terminal/Terminal';
import { Dropdown } from '../ui/Dropdown';
import { CloseIcon } from '../ui/icons';
import { Popover } from '../ui/Popover';
import type { Panel } from './route';

export interface MenuItem {
  label: string;
  // A confirmation line shown in the menu before the action runs.
  confirm?: { text: string; action: string };
  run: () => void;
}

// ActionsMenu: the "···" menu. An item with a confirmation turns the menu
// into one line with the action and Cancel.
export function ActionsMenu(props: { items: MenuItem[]; testId?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<MenuItem | null>(null);
  const close = () => {
    setOpen(false);
    setConfirming(null);
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={'c-btn' + (open ? ' on' : '')}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={props.testId ?? 'actions-menu'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        ···
      </button>
      <Popover anchor={anchor} open={open} onClose={close} align="right" label="Actions">
        {confirming ? (
          <div className="menu-confirm" role="alertdialog" aria-label={confirming.confirm!.text}>
            <div>{confirming.confirm!.text}</div>
            <div className="btns">
              <button
                type="button"
                className="c-btn primary"
                onClick={() => {
                  const item = confirming;
                  close();
                  item.run();
                }}
              >
                {confirming.confirm!.action}
              </button>
              <button type="button" className="c-btn" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          props.items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="row"
              onClick={() => {
                if (it.confirm) setConfirming(it);
                else {
                  close();
                  it.run();
                }
              }}
            >
              <span className="t">{it.label}</span>
            </button>
          ))
        )}
      </Popover>
    </>
  );
}

// WorkView: a task or a long-lived agent. The header carries the title,
// "Questions · N" and the menu; the terminal of the selected session stays on
// the right; the questions (or the details) open in a column to its left.
// The terminal keeps its place in the tree, so opening or closing the column
// never remounts it: it only resizes, and only then.
export function WorkView(props: {
  bridge: HoppBridge;
  stream: StreamState;
  title: string;
  tree: Session[];
  selectedId: string;
  onSelect: (id: string) => void;
  panel: Panel;
  onPanel: (p: Panel) => void;
  menu: ReactNode;
  // Above the terminal: a calm line about the state, with its action.
  status: ReactNode;
  // Whether the selected session can be attached to now.
  attachable: boolean;
  // Shown in place of the terminal when it cannot be.
  noTerminal: ReactNode;
  details: ReactNode;
  refreshSession: (id: string) => void;
}) {
  const { bridge, selectedId } = props;
  const selected = props.tree.find((s) => s.id === selectedId) ?? null;
  const { asks, reload: reloadAsks } = useAsks(bridge.daemon, selectedId, props.stream);
  const count = asks.filter((a) => a.status === 'open').length + (selected?.question ? 1 : 0);
  const [nonce, setNonce] = useState(0);
  const [closed, setClosed] = useState(false);
  const live = !!selected && (selected.state === 'running' || selected.state === 'spawning');

  // A new session or a fresh attach starts with an open terminal.
  useEffect(() => setClosed(false), [selectedId, nonce]);

  const open = props.panel !== null;
  const options = props.tree.map((s) => ({ value: s.id, label: `${s.id} · ${sessionWord(s)}`, dim: !(s.state === 'running' || s.state === 'spawning') }));

  return (
    <div className={'task' + (open ? ' q-open' : '')} data-testid="zone-right">
      <div className="top task-top">
        <span className="name" title={props.title}>
          {props.title}
        </span>
        <button
          type="button"
          className={'c-btn' + (props.panel === 'questions' ? ' on' : '')}
          data-testid="questions-button"
          aria-pressed={props.panel === 'questions'}
          onClick={() => props.onPanel(props.panel === 'questions' ? null : 'questions')}
        >
          {count > 0 ? `Questions · ${count}` : 'Questions'}
        </button>
        <span className="sp" />
        {props.menu}
      </div>
      {open && (
        <section className="task-q" data-testid="zone-middle" aria-label={props.panel === 'details' ? 'Details' : 'Questions'}>
          <div className="q-head">
            <span>{props.panel === 'details' ? 'Details' : 'Questions'}</span>
            <span className="sp" />
            <button type="button" className="c-btn icon" aria-label="Close the column" onClick={() => props.onPanel(null)}>
              <CloseIcon />
            </button>
          </div>
          {props.panel === 'details' ? (
            <div className="q-body">{props.details}</div>
          ) : (
            <QuestionsPanel
              daemon={bridge.daemon}
              session={selected}
              sessionId={selectedId}
              asks={asks}
              reloadAsks={reloadAsks}
              reloadSession={props.refreshSession}
            />
          )}
        </section>
      )}
      {open && <div className="task-div" aria-hidden />}
      <section className="task-term" aria-label="Terminal">
        {open && <div className="term-label">Terminal</div>}
        <div className="term-bar">
          {props.tree.length > 0 && (
            <Dropdown
              label={selected ? `${selected.id} · ${sessionWord(selected)}` : selectedId}
              testId="session-picker"
              options={options}
              value={selectedId}
              onChange={props.onSelect}
            />
          )}
          {props.status && <div className="status-line">{props.status}</div>}
          {closed && live && props.attachable && (
            <div className="status-line">
              Terminal closed.
              <button type="button" className="c-btn" onClick={() => setNonce((n) => n + 1)}>
                Reattach
              </button>
            </div>
          )}
        </div>
        <div className="term-box">
          {props.attachable && selected ? (
            <Terminal key={selectedId + ':' + nonce} sessionId={selectedId} bridge={bridge.terminal} onEnded={() => setClosed(true)} />
          ) : (
            <div className="term-empty">{props.noTerminal}</div>
          )}
        </div>
      </section>
    </div>
  );
}
