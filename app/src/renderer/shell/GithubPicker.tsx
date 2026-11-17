// GithubPicker: find one of the human's GitHub repositories (through their
// own gh) and pick it. A popover under its button: a search field, the list
// (most recently pushed first) and the states around it: gh not set up,
// loading, an error, nothing found. Arrow keys move, Enter picks, Escape
// closes.
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { GithubRepo, ShellBridge } from '../../shared/shell';
import { cleanError } from '../errors';
import { Popover } from '../ui/Popover';
import { LockIcon } from '../ui/icons';
import { updatedAgo, useGithub } from './repos';

const SEARCH_DEBOUNCE_MS = 200;

export function GithubPicker(props: {
  shell: ShellBridge;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onPick: (repo: GithubRepo) => void;
  // owner/repo names already in the field: shown, but not offered again.
  taken: string[];
}) {
  return (
    <Popover anchor={props.anchor} open={props.open} onClose={props.onClose} role="dialog" label="Choose a repository from GitHub" className="gh-picker">
      {props.open && <PickerBody {...props} />}
    </Popover>
  );
}

function PickerBody(props: Parameters<typeof GithubPicker>[0]) {
  const gh = useGithub();
  const status = gh.status;
  const [checking, setChecking] = useState(false);

  if (!status) return <div className="gh-state">Checking GitHub…</div>;
  if (!status.available) {
    return (
      <div className="gh-state gh-unavailable" data-testid="gh-unavailable">
        <div className="gh-state-title">GitHub is not available</div>
        <div>{status.reason}</div>
        {status.command && (
          <div className="gh-command">
            Run <code className="selectable">{status.command}</code> in a terminal, then check again.
          </div>
        )}
        <div className="gh-state-actions">
          <button
            type="button"
            className="c-btn"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await gh.refresh();
              setChecking(false);
            }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    );
  }
  return <RepoSearch {...props} login={status.login} />;
}

function RepoSearch(props: Parameters<typeof GithubPicker>[0] & { login: string }) {
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const n = ++seq.current;
    const run = async () => {
      try {
        const r = await props.shell.listGithubRepos(query.trim());
        if (n !== seq.current) return;
        if (r.ok) {
          setRepos(r.value);
          setError(null);
        } else setError(r.error.message);
      } catch (err) {
        if (n === seq.current) setError(cleanError(err));
      }
      if (n === seq.current) setActive(0);
    };
    // The first list comes at once; typing waits for a pause.
    const t = setTimeout(() => void run(), repos === null && !query ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, attempt, props.shell]);

  const taken = new Set(props.taken);
  const offered = (repos ?? []).filter((r) => !taken.has(r.fullName));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const pick = (r: GithubRepo | undefined) => {
    if (!r) return;
    props.onPick(r);
  };

  return (
    <div className="gh-search">
      <div className="gh-head">
        <input
          className="text-input"
          autoFocus
          value={query}
          placeholder="Search your repositories"
          aria-label="Search repositories"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={offered[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, Math.max(0, offered.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(offered[active]);
            }
          }}
        />
        {props.login && <span className="gh-login">as {props.login}</span>}
      </div>
      <div className="gh-list" ref={list} id={listId} role="listbox" aria-label="Repositories">
        {error ? (
          <div className="gh-state" role="alert">
            <div>Could not list repositories: {error}</div>
            <div className="gh-state-actions">
              <button type="button" className="c-btn" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </div>
          </div>
        ) : repos === null ? (
          <div className="gh-state">Loading your repositories…</div>
        ) : offered.length === 0 ? (
          <div className="gh-state">
            {query.trim()
              ? `No repositories match “${query.trim()}”.`
              : repos.length > 0
                ? 'Every repository is already in this field.'
                : 'This account has no repositories.'}
          </div>
        ) : (
          offered.map((r, i) => (
            <div
              key={r.fullName}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-index={i}
              data-testid="gh-repo"
              className={'gh-repo' + (i === active ? ' active' : '')}
              onMouseMove={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              <div className="gh-repo-line">
                <span className="gh-repo-name">{r.fullName}</span>
                {r.private && (
                  <span className="gh-tag" title="Private repository">
                    <LockIcon /> Private
                  </span>
                )}
                {r.cloned && (
                  <span className="gh-tag" title="Already cloned into hopp">
                    Cloned
                  </span>
                )}
                <span className="sp" />
                <span className="gh-repo-when">{updatedAgo(r.updatedAt)}</span>
              </div>
              {r.description && <div className="gh-repo-desc">{r.description}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
