import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { TerminalBridge } from '../../shared/bridge';
import { hopp } from '../bridge';

const RESIZE_DEBOUNCE_MS = 80;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // ipcRenderer.invoke wraps main-process errors in this prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

// Terminal shows one session in xterm.js. It opens a pty on mount and closes
// it on unmount (which detaches the tmux client). The terminal size changes
// only when its own container changes size; nothing else resizes it.
export function Terminal(props: { sessionId: string; bridge?: TerminalBridge; onEnded?: () => void }) {
  const { sessionId } = props;
  const bridge = props.bridge ?? hopp().terminal;
  const box = useRef<HTMLDivElement>(null);
  const onEnded = useRef(props.onEnded);
  onEnded.current = props.onEnded;

  useEffect(() => {
    const el = box.current!;
    const term = new XTerm({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: parseInt(cssVar('--font-size-mono', '13'), 10) || 13,
      theme: { background: cssVar('--bg', '#000000'), foreground: cssVar('--fg', '#ffffff') },
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
      term.write('\r\n\x1b[2m[the session terminal ended]\x1b[0m\r\n');
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
        for (const [eid, d] of early) if (eid === id) term.write(d);
        early.length = 0;
        term.focus();
      },
      (err) => {
        if (disposed) return;
        ended = true;
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

  return <div ref={box} className="terminal" data-testid="terminal" />;
}
