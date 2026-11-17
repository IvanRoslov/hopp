// The project form's repository fields. A repository comes from GitHub (a
// managed clone; the clone may take a while and happens in place) or from a
// folder on this Mac (picked, or a path typed in). A chosen repository is a
// row with its name and a remove button; the full path is in its tooltip.
import { useId, useRef, useState, type ReactNode } from 'react';
import type { GithubRepo, Result, ShellBridge } from '../../shared/shell';
import { cleanError } from '../errors';
import { CloseIcon, FolderIcon, GithubIcon } from '../ui/icons';
import { GithubPicker } from './GithubPicker';
import { RepoLabel, useRepoName } from './repos';

// useClone: one clone at a time per field. While it runs the field shows
// "Cloning owner/repo…"; the result is a path, or an error for the field.
function useClone(shell: ShellBridge, onCloning: (name: string | null) => void) {
  const [cloning, setCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (repo: GithubRepo, done: (path: string) => void) => {
    setError(null);
    setCloning(repo.fullName);
    onCloning(repo.fullName);
    let r: Result<{ path: string }>;
    try {
      r = await shell.addGithubRepo(repo.fullName);
    } catch (err) {
      r = { ok: false, error: { code: 'failed', message: cleanError(err) } };
    }
    setCloning(null);
    onCloning(null);
    if (r.ok) done(r.value.path);
    else setError(`Could not clone ${repo.fullName}: ${r.error.message}`);
  };
  return { cloning, error, setError, run };
}

function Sources(props: {
  shell: ShellBridge;
  disabled: boolean;
  taken: string[];
  folderLabel: string;
  onRepo: (repo: GithubRepo) => void;
  onFolder: (dir: string) => void;
  onError: (message: string) => void;
}) {
  const ghButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="repo-sources">
      <button
        ref={ghButton}
        type="button"
        className={'c-btn' + (open ? ' on' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <GithubIcon /> Choose from GitHub
      </button>
      <button
        type="button"
        className="c-btn"
        disabled={props.disabled}
        onClick={async () => {
          try {
            const dir = await props.shell.pickFolder();
            if (dir) props.onFolder(dir);
          } catch (err) {
            props.onError(cleanError(err));
          }
        }}
      >
        <FolderIcon /> {props.folderLabel}
      </button>
      <GithubPicker
        shell={props.shell}
        anchor={ghButton}
        open={open}
        onClose={() => setOpen(false)}
        taken={props.taken}
        onPick={(r) => {
          setOpen(false);
          props.onRepo(r);
        }}
      />
    </div>
  );
}

function FieldFrame(props: { label: string; labelFor?: string; error?: string | null; hint?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <div className={'field repo-field' + (props.error ? ' has-error' : '')} data-testid={props.testId}>
      <label className="fl" htmlFor={props.labelFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <small className="error" role="alert">
          {props.error}
        </small>
      ) : props.hint ? (
        <small>{props.hint}</small>
      ) : null}
    </div>
  );
}

function RepoRow(props: { path: string; onRemove: () => void; disabled?: boolean }) {
  return (
    <div className="repo-row" data-testid="repo-row">
      <RepoLabel path={props.path} />
      <button
        type="button"
        className="c-btn icon repo-remove"
        aria-label={`Remove ${props.path}`}
        title="Remove"
        disabled={props.disabled}
        onClick={props.onRemove}
      >
        <CloseIcon width={12} height={12} />
      </button>
    </div>
  );
}

function CloningRow(props: { name: string }) {
  return (
    <div className="repo-row cloning" role="status" data-testid="repo-cloning">
      <span className="repo-spinner" aria-hidden />
      <span className="repo-text">Cloning {props.name}…</span>
    </div>
  );
}

// RepoSlot: the orchestrator's repository, one or none.
export function RepoSlot(props: {
  shell: ShellBridge;
  label: string;
  value: string;
  onChange: (path: string) => void;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  onCloning: (name: string | null) => void;
}) {
  const inputId = useId();
  const name = useRepoName();
  const clone = useClone(props.shell, props.onCloning);
  // A clone from GitHub is a row (owner/repo); a folder path stays editable.
  const current = props.value ? name(props.value) : null;
  const set = (path: string) => {
    clone.setError(null);
    props.onChange(path);
  };
  return (
    <FieldFrame
      label={props.label}
      labelFor={!current && !clone.cloning ? inputId : undefined}
      error={props.error ?? clone.error}
      hint={props.hint}
      testId="repo-slot"
    >
      {clone.cloning ? (
        <CloningRow name={clone.cloning} />
      ) : !current ? (
        <input
          id={inputId}
          className="repo-input"
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => {
            clone.setError(null);
            props.onChange(e.target.value);
          }}
        />
      ) : (
        <RepoRow path={props.value} onRemove={() => props.onChange('')} />
      )}
      <Sources
        shell={props.shell}
        disabled={!!clone.cloning}
        taken={current ? [current] : []}
        folderLabel="Choose folder"
        onRepo={(r) => void clone.run(r, set)}
        onFolder={set}
        onError={clone.setError}
      />
    </FieldFrame>
  );
}

// RepoList: the workers' repositories, any number. A path typed into the
// input is added with Enter (and is kept by the form when it saves).
export function RepoList(props: {
  shell: ShellBridge;
  label: string;
  value: string[];
  onChange: (paths: string[]) => void;
  draft: string;
  onDraft: (text: string) => void;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  onCloning: (name: string | null) => void;
}) {
  const inputId = useId();
  const name = useRepoName();
  const clone = useClone(props.shell, props.onCloning);
  const add = (path: string) => {
    const p = path.trim();
    if (p && !props.value.includes(p)) props.onChange([...props.value, p]);
  };
  const taken = props.value.map(name).filter((n): n is string => !!n);
  return (
    <FieldFrame label={props.label} labelFor={inputId} error={props.error ?? clone.error} hint={props.hint} testId="repo-list">
      {(props.value.length > 0 || clone.cloning) && (
        <div className="repo-rows">
          {props.value.map((p) => (
            <RepoRow key={p} path={p} onRemove={() => props.onChange(props.value.filter((x) => x !== p))} />
          ))}
          {clone.cloning && <CloningRow name={clone.cloning} />}
        </div>
      )}
      <input
        id={inputId}
        className="repo-input"
        value={props.draft}
        placeholder={props.placeholder}
        onChange={(e) => {
          clone.setError(null);
          props.onDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && props.draft.trim()) {
            e.preventDefault();
            add(props.draft);
            props.onDraft('');
          }
        }}
      />
      <Sources
        shell={props.shell}
        disabled={!!clone.cloning}
        taken={taken}
        folderLabel="Add folder"
        onRepo={(r) => void clone.run(r, add)}
        onFolder={add}
        onError={clone.setError}
      />
    </FieldFrame>
  );
}
