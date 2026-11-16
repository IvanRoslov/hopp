import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { TerminalBridge } from '../../shared/bridge';
import { hopp } from '../bridge';
import { cleanError } from '../errors';

const RESIZE_DEBOUNCE_MS = 80;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Terminal shows one session in xterm.js. It opens a pty on mount and closes
// it on unmount (which detaches the tmux client). When the pty ends (the
// session ended, or the human detached with the tmux key) it prints one line
// and calls onEnded; the parent offers to reattach. The terminal size changes
// only when its own container changes size; nothing else resizes it.
export function Terminal(props: { sessionId: string; bridge?: TerminalBridge; onEnded?: () => void }) {
  const { sessionId } = props;
  const bridge = props.bridge ?? hopp().terminal;
  const box = useRef<HTMLDivElement>(null);
  const onEnded = useRef(props.onEnded);
  onEnded.current = props.onEnded;
  // Until the pty is open (the first attach may wait for the login shell's
  // PATH), the box says so instead of standing empty.
  const [attaching, setAttaching] = useState(true);

  useEffect(() => {
    const el = box.current!;
    const term = new XTerm({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: parseInt(cssVar('--fs-mono', '13'), 10) || 13,
      lineHeight: 1.25,
      // The terminal keeps its dark colors in both themes.
      theme: {
        background: cssVar('--term', '#100f0e'),
        foreground: cssVar('--term-ink', '#cfccc7'),
        cursor: cssVar('--term-cursor', '#cfccc7'),
        selectionBackground: cssVar('--term-selection', 'rgba(207,204,199,.25)'),
      },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      // Not laid out yet: xterm keeps its default size.
    }

    let termId: string | null = null;
    let ended = false;
    let disposed = false;
    let sent = { cols: term.cols, rows: term.rows };
    const early: [string, string][] = [];

    const offData = bridge.onData((id, data) => {
      if (termId === null) early.push([id, data]);
      else if (id === termId) term.write(data);
    });
    const offExit = bridge.onExit((id) => {
      if (id !== termId || ended) return;
      ended = true;
      term.write('\r\n\x1b[2m[terminal closed]\x1b[0m\r\n');
      onEnded.current?.();
    });
    const input = term.onData((d) => {
      if (termId !== null && !ended) bridge.write(termId, d);
    });

    bridge.open(sessionId, sent.cols, sent.rows).then(
      (id) => {
        if (disposed) {
          bridge.close(id);
          return;
        }
        termId = id;
        setAttaching(false);
        for (const [eid, d] of early) if (eid === id) term.write(d);
        early.length = 0;
        term.focus();
      },
      (err) => {
        if (disposed) return;
        ended = true;
        setAttaching(false);
        term.write(`\x1b[31mcannot open the terminal: ${cleanError(err)}\x1b[0m\r\n`);
      },
    );

    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        if (term.cols === sent.cols && term.rows === sent.rows) return;
        sent = { cols: term.cols, rows: term.rows };
        if (termId !== null && !ended) bridge.resize(termId, sent.cols, sent.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ro.disconnect();
      offData();
      offExit();
      input.dispose();
      if (termId !== null && !ended) bridge.close(termId);
      term.dispose();
    };
  }, [sessionId, bridge]);

  return (
    <div ref={box} className="terminal" data-testid="terminal">
      {attaching && <div className="term-attaching">Attaching…</div>}
    </div>
  );
}
