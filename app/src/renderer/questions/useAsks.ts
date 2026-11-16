import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonBridge } from '../../shared/bridge';
import type { Ask, StreamState } from '../../shared/types';

// useAsks keeps the asks one session raised (open and closed), reloading on
// that session's ask events and whenever the stream opens.
export function useAsks(daemon: DaemonBridge, sessionId: string | null, stream: StreamState) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const seq = useRef(0);

  const reload = useCallback(() => {
    const n = ++seq.current;
    if (!sessionId) {
      setAsks([]);
      return;
    }
    daemon.listAsks({ from: sessionId, status: 'all' }).then(
      (list) => {
        if (n === seq.current) setAsks(list.filter((a) => a.from === sessionId));
      },
      () => {},
    );
  }, [daemon, sessionId]);

  useEffect(() => {
    setAsks([]);
    if (stream === 'open') reload();
  }, [reload, stream]);

  useEffect(
    () =>
      daemon.onEvent((e) => {
        if (e.type.startsWith('ask.') && e.session_id === sessionId) reload();
      }),
    [daemon, sessionId, reload],
  );

  return { asks, reload };
}
