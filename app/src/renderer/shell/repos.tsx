// GitHub on the page: the gh status (read once, re-read on demand) and how a
// repository path is named. A managed clone (a path under <HOPP_HOME>/repos)
// reads as owner/repo with the GitHub mark; any other folder as its path.
// The full path is always in the tooltip.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { managedRepoName } from '../../shared/repos';
import type { GithubStatus, ShellBridge } from '../../shared/shell';
import { cleanError } from '../errors';
import { FolderIcon, GithubIcon } from '../ui/icons';

interface GithubCtx {
  // null until the first answer.
  status: GithubStatus | null;
  // Asks gh again (after the human installed it or logged in).
  refresh: () => Promise<void>;
}

const Ctx = createContext<GithubCtx>({ status: null, refresh: async () => {} });

export function GithubProvider(props: { shell: ShellBridge; children: ReactNode }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await props.shell.githubStatus());
    } catch (err) {
      setStatus({ available: false, login: '', reason: cleanError(err), command: '', home: '' });
    }
  }, [props.shell]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ status, refresh }}>{props.children}</Ctx.Provider>;
}

export function useGithub(): GithubCtx {
  return useContext(Ctx);
}

// useRepoName: owner/repo for a managed clone, else null.
export function useRepoName(): (path: string) => string | null {
  const home = useGithub().status?.home ?? '';
  return useCallback((path: string) => (home ? managedRepoName(path, home) : null), [home]);
}

// RepoLabel: a repository path as the human reads it.
export function RepoLabel(props: { path: string; className?: string }) {
  const name = useRepoName()(props.path);
  return (
    <span className={'repo-label' + (props.className ? ' ' + props.className : '')} title={props.path} data-testid="repo-label">
      {name ? <GithubIcon className="repo-mark" /> : <FolderIcon className="repo-mark" />}
      <span className="repo-text">{name ?? props.path}</span>
    </span>
  );
}

// "updated 3 days ago", from an ISO time.
export function updatedAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(s) >= size) return 'updated ' + rtf.format(Math.round(s / size), unit);
  }
  return 'updated just now';
}
