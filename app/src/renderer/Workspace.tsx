import { useState } from 'react';
import type { HoppBridge } from '../shared/bridge';
import { hopp } from './bridge';
import { DaemonDown } from './frame/DaemonDown';
import { Frame } from './frame/Frame';
import { QuestionsButton, QuestionsColumn, questionCount } from './questions/Questions';
import { useAsks } from './questions/useAsks';
import { stateWord } from './sessions/model';
import { SessionList } from './sessions/SessionList';
import { useSessions } from './sessions/useSessions';
import { Terminal } from './terminal/Terminal';

// Workspace is the whole screen: the daemon state, the session list, the
// selected session's terminal.
export function Workspace(props: { bridge?: HoppBridge }) {
  const bridge = props.bridge ?? hopp();
  const { stream, sessions, refresh } = useSessions(bridge.daemon);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const { asks, reload: reloadAsks } = useAsks(bridge.daemon, selectedId, stream);

  if (stream === 'down') return <DaemonDown daemon={bridge.daemon} />;
  if (stream === 'connecting') return <div className="connecting">Connecting to the hopp daemon…</div>;

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  // The header stays while a session is selected, whatever happens to the
  // session, so the terminal below it never moves.
  const header = selectedId && (
    <>
      <span className="header-id">{selectedId}</span>
      <span className="muted" data-testid="selected-state">
        {selected ? stateWord(selected) : 'gone'}
      </span>
      <span className="header-spacer" />
      <QuestionsButton
        count={questionCount(selected, asks)}
        open={showQuestions}
        onToggle={() => setShowQuestions((v) => !v)}
      />
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
      middle={
        showQuestions && selected ? (
          <QuestionsColumn
            daemon={bridge.daemon}
            session={selected}
            asks={asks}
            reloadAsks={reloadAsks}
            reloadSession={refresh}
          />
        ) : null
      }
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
