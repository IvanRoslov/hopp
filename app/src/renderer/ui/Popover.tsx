// Popover: a menu anchored under a trigger, rendered on top of everything.
// Closes on Escape, on a click outside, and when the window resizes.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  children: ReactNode;
  label?: string;
  // A popover that is not a menu (a picker with a search field) says so.
  role?: 'menu' | 'dialog';
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const { open, onClose, anchor, align } = props;

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return;
    const w = box.current?.offsetWidth ?? 220;
    const h = box.current?.offsetHeight ?? 0;
    let left = align === 'right' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = a.bottom + 6;
    if (h && top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
    setPos({ top, left });
  }, [open, anchor, align, props.children]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', down);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('mousedown', down);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={box}
      className={'menu' + (props.className ? ' ' + props.className : '')}
      role={props.role ?? 'menu'}
      aria-label={props.label}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
