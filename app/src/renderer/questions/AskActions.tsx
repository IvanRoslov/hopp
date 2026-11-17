// What every open ask offers besides its own buttons: an answer in the
// human's own words when none of the options fits ("Other…"), and closing it
// as no longer relevant ("Not relevant"), which the asker is told about.
import { useState } from 'react';
import type { Ask } from '../../shared/types';

// isDismissed: closed by the human as not relevant (the daemon withdraws it
// with the reason "dismissed").
export const isDismissed = (a: Ask): boolean => a.status === 'withdrawn' && a.reason === 'dismissed';

export const DISMISSED_LINE = 'Dismissed · not relevant';

// OwnAnswer: "Other…" opens a text field; its text is the whole answer.
export function OwnAnswer(props: { busy: boolean; onSend: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return (
      <button type="button" className="c-btn" disabled={props.busy} onClick={() => setOpen(true)} data-testid="ask-other">
        Other…
      </button>
    );
  }
  const send = () => {
    if (text.trim() && !props.busy) props.onSend(text.trim());
  };
  return (
    <div className="inline-field own-answer">
      <input
        className="text-input"
        aria-label="Your own answer"
        placeholder="Your own answer"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) send();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <button type="button" className="c-btn primary" disabled={props.busy || !text.trim()} onClick={send}>
        Answer
      </button>
      <button type="button" className="c-btn" disabled={props.busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

// DismissAsk: a quiet "Not relevant", then one line to confirm.
export function DismissAsk(props: { busy: boolean; onDismiss: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="link-btn quiet-dismiss" disabled={props.busy} onClick={() => setConfirming(true)} data-testid="ask-dismiss">
        Not relevant
      </button>
    );
  }
  return (
    <div className="dismiss-confirm" role="group" aria-label="Dismiss this question">
      <span>Close this question without an answer? The agent is told not to wait for it.</span>
      <button type="button" className="c-btn" disabled={props.busy} onClick={props.onDismiss} data-testid="ask-dismiss-confirm">
        Close it
      </button>
      <button type="button" className="link-btn" disabled={props.busy} onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </div>
  );
}
