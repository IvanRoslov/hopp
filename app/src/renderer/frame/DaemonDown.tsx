import { useEffect, useState } from 'react';
import type { DaemonBridge } from '../../shared/bridge';

// DaemonDown fills the content area while no daemon answers on the socket.
// The app keeps retrying on its own; the button runs `hopp daemon start`.
export function DaemonDown(props: { daemon: DaemonBridge }) {
  const [socketPath, setSocketPath] = useState('');
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    props.daemon.socketPath().then(setSocketPath, () => {});
  }, [props.daemon]);

  const start = async () => {
    setStarting(true);
    setNote(null);
    try {
      const r = await props.daemon.startDaemon();
      setNote(r.ok ? 'Started. Connecting…' : r.message);
    } catch (err) {
      setNote(String((err as Error)?.message ?? err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="daemon-down" data-testid="daemon-down">
      <h2>The hopp daemon is not running</h2>
      <p className="muted">Trying to connect to {socketPath || '…'}. The app retries on its own.</p>
      <button onClick={start} disabled={starting}>
        Start daemon
      </button>
      {note && <p className="daemon-note">{note}</p>}
    </div>
  );
}
