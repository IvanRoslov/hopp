import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonBridge } from '../../shared/bridge';
import type { Session, StreamState } from '../../shared/types';

export interface SessionsState {
  stream: StreamState;
  sessions: Session[];
  error: string | null;
  // refresh reloads one session from the daemon.
  refresh: (id: string) => void;
}

// useSessions loads the session list once the event stream is open and then
// follows events. Every time the stream opens (after a drop or a daemon
// restart) it loads the whole list again, so nothing missed stays stale.
export function useSessions(daemon: DaemonBridge): SessionsState {
  const [stream, setStream] = useState<StreamState>('connecting');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const refreshRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    let alive = true;
    const load = () => {
      const seq = ++loadSeq.current;
      daemon.listSessions({ all: true }).then(
        (list) => {
          if (!alive || seq !== loadSeq.current) return;
          setSessions(list);
          setError(null);
        },
        (err) => {
          if (alive && seq === loadSeq.current) setError(String(err?.message ?? err));
        },
      );
    };
    const onState = (s: StreamState) => {
      if (!alive) return;
      setStream(s);
      if (s === 'open') load();
    };
    const offState = daemon.onStreamState(onState);
    const refresh = (id: string) => {
      daemon.getSession(id).then(
        (s) => {
          if (!alive) return;
          setSessions((l) => {
            if (!s) return l.filter((x) => x.id !== id);
            const i = l.findIndex((x) => x.id === id);
            if (i < 0) return [...l, s];
            const next = l.slice();
            next[i] = s;
            return next;
          });
        },
        () => {
          // The stream's state change will trigger a full reload.
        },
      );
    };
    refreshRef.current = refresh;
    const offEvent = daemon.onEvent((e) => {
      if (!alive || !e.session_id || !e.type.startsWith('session.')) return;
      const id = e.session_id;
      if (e.type === 'session.removed') {
        setSessions((l) => l.filter((s) => s.id !== id));
        return;
      }
      refresh(id);
    });
    daemon.streamState().then(onState, () => {});
    return () => {
      alive = false;
      offState();
      offEvent();
    };
  }, [daemon]);

  const refresh = useCallback((id: string) => refreshRef.current(id), []);
  return { stream, sessions, error, refresh };
}
