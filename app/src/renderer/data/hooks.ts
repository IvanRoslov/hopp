import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonBridge } from '../../shared/bridge';
import type { ModelProfile, ShellBridge, ShellState } from '../../shared/shell';
import type { StreamState, Waiting } from '../../shared/types';
import { cleanError } from '../errors';

export type ShellLoad =
  | { status: 'loading' }
  | { status: 'ready'; state: ShellState }
  | { status: 'unwired' }
  | { status: 'error'; message: string; retry: () => void };

// The preload's placeholder rejects every shell call with this text until
// the main process implements the shell layer.
const UNWIRED = /not wired/;

// useShellState loads the shell store once and then follows its changes.
export function useShellState(shell: ShellBridge): ShellLoad {
  const [load, setLoad] = useState<ShellLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    // The preload's placeholder answers every call, onChanged included,
    // with a rejected promise; swallow that instead of leaving it unhandled.
    let off: unknown;
    try {
      off = shell.onChanged((s) => alive && setLoad({ status: 'ready', state: s }));
    } catch {
      off = undefined;
    }
    if (off && typeof (off as Promise<unknown>).then === 'function') (off as Promise<unknown>).catch(() => {});
    shell.state().then(
      (s) => alive && setLoad({ status: 'ready', state: s }),
      (err) => {
        if (!alive) return;
        const message = cleanError(err);
        if (UNWIRED.test(message)) setLoad({ status: 'unwired' });
        else setLoad({ status: 'error', message, retry: () => setAttempt((n) => n + 1) });
      },
    );
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, [shell, attempt]);
  return load;
}

// debounced runs fn at most once per `ms` after a burst of triggers.
function useDebounced(fn: () => void, ms: number) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => {
    if (t.current) clearTimeout(t.current);
  }, []);
  return useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      t.current = null;
      f.current();
    }, ms);
  }, [ms]);
}

const WAITING_EVENTS = /^(ask\.|session\.)/;

// useWaiting keeps "Waiting for you": everything open for the human. It
// reloads when the stream opens and after ask and session events.
export function useWaiting(shell: ShellBridge, daemon: DaemonBridge, stream: StreamState, enabled: boolean) {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!enabled) return;
    const n = ++seq.current;
    shell.waiting().then(
      (w) => n === seq.current && setWaiting(w),
      () => {},
    );
  }, [shell, enabled]);
  const soon = useDebounced(load, 120);
  useEffect(() => {
    if (stream === 'open') load();
  }, [stream, load]);
  useEffect(() => daemon.onEvent((e) => WAITING_EVENTS.test(e.type) && soon()), [daemon, soon]);
  return { waiting, reload: load };
}

// useAgentMail: unread mail per long-lived agent (shown while one is off).
export function useAgentMail(shell: ShellBridge, daemon: DaemonBridge, stream: StreamState, enabled: boolean) {
  const [mail, setMail] = useState<Record<string, number>>({});
  const load = useCallback(() => {
    if (!enabled) return;
    shell.agentMail().then(setMail, () => {});
  }, [shell, enabled]);
  const soon = useDebounced(load, 300);
  useEffect(() => {
    if (stream === 'open') load();
  }, [stream, load]);
  useEffect(() => daemon.onEvent((e) => (e.type.startsWith('mailbox.') || e.type.startsWith('session.')) && soon()), [daemon, soon]);
  return mail;
}

// useProfiles: the daemon's model profiles (enabled first).
export function useProfiles(shell: ShellBridge) {
  const [profiles, setProfiles] = useState<ModelProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    shell.listProfiles().then(setProfiles, (e) => setError(cleanError(e)));
  }, [shell]);
  useEffect(load, [load]);
  return { profiles, error, reload: load };
}
