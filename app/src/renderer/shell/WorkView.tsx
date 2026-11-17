import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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

// ConfirmButton: a visible action (Stop) that asks first, in a small
// popover under the button, the way a menu item with a confirmation does.
export function ConfirmButton(props: { label: string; confirm: { text: string; action: string }; run: () => void; disabled?: boolean; testId?: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={'c-btn' + (open ? ' on' : '')}
        disabled={props.disabled}
        data-testid={props.testId}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="left" label={props.label}>
        <div className="menu-confirm" role="alertdialog" aria-label={props.confirm.text}>
          <div>{props.confirm.text}</div>
          <div className="btns">
            <button
              type="button"
              className="c-btn primary"
              onClick={() => {
                setOpen(false);
                props.run();
              }}
            >
              {props.confirm.action}
            </button>
            <button type="button" className="c-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

// WorkView: a task or a long-lived agent. The header is one row: the title,
// Start or Stop, "Questions · N", the session picker, a quiet status and the
// menu; an error or a warning adds a second line only while there is one. The
// terminal of the selected session starts right under it; the questions (or
// the details) open in a column to its left, and then the picker moves to
// the terminal's own head.
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
  // The visible action before Questions: Start, Stop or Resume.
  action?: ReactNode;
  // A quiet word about the state; cut with an ellipsis, whole in the tooltip.
  status?: string | null;
  // An error or a warning, with its ways out: a second line while present.
  alert?: ReactNode;
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
  const open = props.panel !== null;
  const split = useSplit();
  // Where the terminal's picker goes: the header, or the terminal's head
  // while a column is open.
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  const [termSlot, setTermSlot] = useState<HTMLElement | null>(null);

  return (
    <div
      ref={split.grid}
      className={'task' + (open ? ' q-open' : '')}
      data-testid="work-view"
      style={open && split.width !== null ? { gridTemplateColumns: `min(${split.width}px, calc(100% - ${MIN_TERM + 5}px)) 5px minmax(0, 1fr)` } : undefined}
    >
      <div className="top task-top">
        <div className="top-row">
          <span className="name" title={props.title}>
            {props.title}
          </span>
          {props.action}
          <button
            type="button"
            className={'c-btn' + (props.panel === 'questions' ? ' on' : '')}
            data-testid="questions-button"
            aria-pressed={props.panel === 'questions'}
            onClick={() => props.onPanel(props.panel === 'questions' ? null : 'questions')}
          >
            {count > 0 ? `Questions · ${count}` : 'Questions'}
          </button>
          <span className="top-slot" ref={setHeadSlot} />
          {props.status && (
            <span className="top-status" title={props.status} data-testid="work-status">
              {props.status}
            </span>
          )}
          <span className="sp" />
          {props.menu}
        </div>
        {props.alert && <div className="top-alert">{props.alert}</div>}
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
      {open && (
        <div
          className="task-div"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the column"
          tabIndex={0}
          title="Drag to resize; double-click to reset"
          onPointerDown={split.onPointerDown}
          onKeyDown={split.onKeyDown}
          onDoubleClick={split.reset}
        />
      )}
      <section className="task-term" aria-label="Terminal">
        {open && (
          <div className="term-label">
            <span>Terminal</span>
            <span className="top-slot" ref={setTermSlot} />
          </div>
        )}
        <TerminalArea
          bridge={bridge}
          tree={props.tree}
          selectedId={selectedId}
          onSelect={props.onSelect}
          barSlot={open ? termSlot : headSlot}
          attachable={props.attachable}
          noTerminal={props.noTerminal}
        />
      </section>
    </div>
  );
}

// TerminalArea: the session picker and the terminal of the selected session
// (or why there is none). A closed terminal offers Reattach. Task views
// without a pipeline and pipeline task views both use it; a work view puts
// the picker into its header (barSlot), the pipeline view keeps it above the
// terminal.
export function TerminalArea(props: {
  bridge: HoppBridge;
  tree: Session[];
  selectedId: string;
  onSelect: (id: string) => void;
  barSlot?: HTMLElement | null;
  attachable: boolean;
  noTerminal: ReactNode;
}) {
  const { bridge, selectedId } = props;
  const selected = props.tree.find((s) => s.id === selectedId) ?? null;
  const [nonce, setNonce] = useState(0);
  const [closed, setClosed] = useState(false);
  const live = !!selected && (selected.state === 'running' || selected.state === 'spawning');

  // A new session or a fresh attach starts with an open terminal.
  useEffect(() => setClosed(false), [selectedId, nonce]);
  // A session that stops unmounts its terminal; when it runs again (Resume,
  // Start) the terminal mounts and attaches afresh, so the old "closed" goes.
  // A detach from a session that keeps running still waits for Reattach.
  useEffect(() => {
    if (!props.attachable) setClosed(false);
  }, [props.attachable]);

  const options = props.tree.map((s) => ({ value: s.id, label: `${s.id} · ${sessionWord(s)}`, dim: !(s.state === 'running' || s.state === 'spawning') }));
  const bar = (
    <>
      {props.tree.length > 0 && (
        <Dropdown
          label={selected ? `${selected.id} · ${sessionWord(selected)}` : selectedId}
          testId="session-picker"
          options={options}
          value={selectedId}
          onChange={props.onSelect}
        />
      )}
      {closed && live && props.attachable && (
        <span className="term-closed">
          Terminal closed.
          <button type="button" className="c-btn" onClick={() => setNonce((n) => n + 1)}>
            Reattach
          </button>
        </span>
      )}
    </>
  );
  const hasBar = props.tree.length > 0 || (closed && live && props.attachable);
  return (
    <>
      {props.barSlot !== undefined ? (props.barSlot ? createPortal(bar, props.barSlot) : null) : hasBar && <div className="term-bar">{bar}</div>}
      <div className="term-box">
        {props.attachable && selected ? (
          <Terminal key={selectedId + ':' + nonce} sessionId={selectedId} bridge={bridge.terminal} onEnded={() => setClosed(true)} />
        ) : (
          <div className="term-empty">{props.noTerminal}</div>
        )}
      </div>
    </>
  );
}

// The questions column's width, set by dragging the divider (or the arrow
// keys on it) and remembered. Only the human changes it; the terminal next to
// it resizes only then.
const SPLIT_KEY = 'hopp.questionsWidth';
const MIN_Q = 280;
const MIN_TERM = 360;

function readSplit(): number | null {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(v) && v >= MIN_Q ? v : null;
  } catch {
    return null;
  }
}

function saveSplit(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(SPLIT_KEY);
    else localStorage.setItem(SPLIT_KEY, String(Math.round(w)));
  } catch {
    // Not remembered; the width still applies now.
  }
}

export function useSplit() {
  const grid = useRef<HTMLDivElement>(null);
  const [width, setWidthState] = useState<number | null>(readSplit);
  // Key repeat and pointer moves arrive faster than renders: read the width
  // from a ref, not from the render's closure.
  const widthRef = useRef<number | null>(width);
  const setWidth = (w: number | null) => {
    widthRef.current = w;
    setWidthState(w);
  };
  const clamp = useCallback((w: number) => {
    const total = grid.current?.getBoundingClientRect().width ?? 0;
    const max = total > 0 ? total - MIN_TERM - 5 : w;
    return Math.max(MIN_Q, Math.min(w, max));
  }, []);
  const current = () => {
    const col = grid.current?.querySelector('.task-q') as HTMLElement | null;
    return widthRef.current ?? (col?.getBoundingClientRect().width || MIN_Q);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const left = grid.current?.getBoundingClientRect().left ?? 0;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    let last = current();
    const move = (ev: PointerEvent) => {
      last = clamp(ev.clientX - left);
      setWidth(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      saveSplit(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = clamp(current() + (e.key === 'ArrowRight' ? step : -step));
    setWidth(next);
    saveSplit(next);
  };

  const reset = () => {
    setWidth(null);
    saveSplit(null);
  };

  return { grid, width, onPointerDown, onKeyDown, reset };
}
