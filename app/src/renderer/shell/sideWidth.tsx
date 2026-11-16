import { useRef, useState } from 'react';

// The left column's width: dragged by its right edge (or the arrow keys on
// it), remembered, reset by a double-click. Only the human changes it.
const KEY = 'hopp.sideWidth';
export const SIDE_MIN = 220;
export const SIDE_MAX = 420;

function read(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= SIDE_MIN && v <= SIDE_MAX ? v : null;
  } catch {
    return null;
  }
}

function save(w: number | null): void {
  try {
    if (w === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(w)));
  } catch {
    // Not remembered.
  }
}

const clamp = (w: number) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, w));

export function useSideWidth() {
  const [width, setState] = useState<number | null>(read);
  const ref = useRef<number | null>(width);
  const set = (w: number | null) => {
    ref.current = w;
    setState(w);
  };
  const current = (el: HTMLElement) => ref.current ?? (el.parentElement?.getBoundingClientRect().width || 264);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const left = el.parentElement?.getBoundingClientRect().left ?? 0;
    el.setPointerCapture?.(e.pointerId);
    let last = current(el);
    const move = (ev: PointerEvent) => {
      last = clamp(ev.clientX - left);
      set(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      save(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = clamp(current(e.currentTarget) + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 48 : 12));
    set(next);
    save(next);
  };
  const reset = () => {
    set(null);
    save(null);
  };
  const style = width !== null ? ({ '--side-w': `${width}px` } as React.CSSProperties) : undefined;
  return { width, style, onPointerDown, onKeyDown, reset };
}

export function SideResizer(props: { side: ReturnType<typeof useSideWidth> }) {
  return (
    <div
      className="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the left column"
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={props.side.onPointerDown}
      onKeyDown={props.side.onKeyDown}
      onDoubleClick={props.side.reset}
    />
  );
}
