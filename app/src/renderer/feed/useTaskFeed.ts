// useTaskFeed loads a task's feed and reloads it whenever the main process
// says that task's feed changed. A reload that fails keeps the last feed and
// reports the error.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellBridge, TaskFeed } from '../../shared/shell';
import { cleanError } from '../errors';

const EMPTY: TaskFeed = { posts: [], asks: [], artifacts: [] };

export function useTaskFeed(shell: ShellBridge, taskId: string) {
  const [feed, setFeed] = useState<TaskFeed>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const f = await shell.taskFeed(taskId);
      if (n !== seq.current) return;
      setFeed(f);
      setError(null);
    } catch (err) {
      if (n === seq.current) setError(cleanError(err));
    } finally {
      if (n === seq.current) setLoaded(true);
    }
  }, [shell, taskId]);

  useEffect(() => {
    setFeed(EMPTY);
    setLoaded(false);
    void reload();
    return shell.onFeedChanged((id) => {
      if (id === taskId) void reload();
    });
  }, [shell, taskId, reload]);

  return { feed, loaded, error, reload };
}
