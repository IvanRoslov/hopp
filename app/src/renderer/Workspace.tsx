import { useState } from 'react';
import type { HoppBridge } from '../shared/bridge';
import { hopp } from './bridge';
import { DaemonDown } from './frame/DaemonDown';
import { Frame } from './frame/Frame';
import { stateWord } from './sessions/model';
import { SessionList } from './sessions/SessionList';
import { useSessions } from './sessions/useSessions';
import { Terminal } from './terminal/Terminal';

// Workspace is the whole screen: the daemon state, the session list, the
// selected session's terminal.
export function Workspace(props: { bridge?: HoppBridge }) {
  const bridge = props.bridge ?? hopp();
  const { stream, sessions } = useSessions(bridge.daemon);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  if (stream === 'down') return <DaemonDown daemon={bridge.daemon} />;
  if (stream === 'connecting') return <div className="connecting">Connecting to the hopp daemon…</div>;

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const header = selected && (
    <>
      <span className="header-id">{selected.id}</span>
      <span className="muted" data-testid="selected-state">
        {stateWord(selected)}
      </span>
    </>
  );

  return (
    <Frame
      header={header}
      left={
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showEnded={showEnded}
          onShowEnded={setShowEnded}
        />
      }
      middle={null}
      right={
        selectedId ? (
          <Terminal key={selectedId} sessionId={selectedId} bridge={bridge.terminal} />
        ) : (
          <div className="placeholder muted">Select a session</div>
        )
      }
    />
  );
}
