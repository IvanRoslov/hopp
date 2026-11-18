// Attachments in a text field: the New task brief and a task feed's line use
// the same parts. useAttachments keeps the list and gives the field its
// paste and drop handlers; AttachButton opens the dialog; AttachmentChips
// shows what is attached before sending; AttachedPaths draws the paths of a
// sent message. An attachment is an absolute path: nothing is copied (see
// shared/attachments.ts).
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { attachmentName, onlyNames, withAttachments, type Attachment, type AttachmentInfo } from '../../shared/attachments';
import type { ShellBridge } from '../../shared/shell';
import { cleanError } from '../errors';
import { ClipIcon, CloseIcon, FileIcon, FolderIcon } from './icons';
import './attachments.css';

type Files = Pick<ShellBridge, 'pickAttachments' | 'pasteAttachments' | 'describePaths' | 'openAttachment' | 'pathForFile'>;

// insertText puts pasted text at the caret the way a paste would, so the
// field's undo and onChange still work.
function insertText(el: HTMLTextAreaElement, text: string): void {
  if (!text) return;
  el.focus();
  if (document.execCommand?.('insertText', false, text)) return;
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export interface AttachmentsState {
  items: AttachmentInfo[];
  // A message about the list (a failed dialog or paste), or null.
  error: string | null;
  dragging: boolean;
  add(list: AttachmentInfo[]): void;
  remove(path: string): void;
  clear(): void;
  pick(): Promise<void>;
  // check: true when every attached path is still there; else the missing
  // ones are marked and nothing should be sent.
  check(): Promise<boolean>;
  // compose: the text with the Attached block at its end.
  compose(text: string): string;
  // The field's handlers.
  field: {
    onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void;
    onDragOver(e: DragEvent<HTMLElement>): void;
    onDragLeave(e: DragEvent<HTMLElement>): void;
    onDrop(e: DragEvent<HTMLElement>): void;
  };
}

export function useAttachments(files: Files): AttachmentsState {
  const [items, setItems] = useState<AttachmentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef(items);
  ref.current = items;

  // A path already attached is not added again.
  const add = useCallback((list: AttachmentInfo[]) => {
    setError(null);
    setItems((cur) => {
      const have = new Set(cur.map((x) => x.path));
      const next = [...cur];
      for (const x of list) {
        if (have.has(x.path)) continue;
        have.add(x.path);
        next.push(x);
      }
      return next;
    });
  }, []);

  const remove = useCallback((path: string) => setItems((cur) => cur.filter((x) => x.path !== path)), []);
  const clear = useCallback(() => {
    setItems([]);
    setError(null);
  }, []);

  const pick = useCallback(async () => {
    try {
      add(await files.pickAttachments());
    } catch (err) {
      setError(cleanError(err));
    }
  }, [files, add]);

  const check = useCallback(async () => {
    const cur = ref.current;
    if (cur.length === 0) return true;
    const now = await files.describePaths(cur.map((x) => x.path));
    const gone = new Set(now.filter((x) => x.missing).map((x) => x.path));
    setItems((list) => list.map((x) => ({ ...x, missing: gone.has(x.path) || undefined })));
    return gone.size === 0;
  }, [files]);

  const compose = useCallback((text: string) => withAttachments(text, ref.current.map(({ path, dir }): Attachment => ({ path, dir }))), []);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // The page cannot see the paths of copied files, so every paste asks
    // the main process first; plain text is then pasted here as usual.
    const el = e.currentTarget;
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    void (async () => {
      try {
        const r = await files.pasteAttachments();
        if (r.kind === 'files') {
          add(r.items);
          // Finder puts the names of the copied files beside them as text.
          if (!onlyNames(text, r.items.map((x) => x.path))) insertText(el, text);
          return;
        }
        if (r.kind === 'image') add(r.items);
      } catch (err) {
        setError(cleanError(err));
      }
      insertText(el, text);
    })();
  };

  const hasFiles = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: DragEvent<HTMLElement>) => {
    setDragging(false);
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length === 0) return;
    e.preventDefault();
    const paths = dropped.map((f) => files.pathForFile(f)).filter(Boolean);
    void files.describePaths(paths).then(add, (err) => setError(cleanError(err)));
  };

  return { items, error, dragging, add, remove, clear, pick, check, compose, field: { onPaste, onDragOver, onDragLeave, onDrop } };
}

export function AttachButton(props: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="c-btn attach-btn"
      aria-label="Attach files or folders"
      title="Attach files or folders (or drop them here, or paste)"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <ClipIcon />
    </button>
  );
}

function Chip(props: { item: AttachmentInfo; onRemove?: () => void; onOpen?: (reveal: boolean) => void }) {
  const { item } = props;
  const name = attachmentName(item.path);
  const icon = item.thumb ? <img className="att-thumb" src={item.thumb} alt="" /> : item.dir ? <FolderIcon /> : <FileIcon />;
  const title = item.dir ? `${item.path}/ (folder)` : item.path;
  const body = (
    <>
      {icon}
      <span className="att-name">{name}</span>
    </>
  );
  return (
    <span className={'att-chip' + (item.missing ? ' missing' : '')} data-path={item.path} data-dir={item.dir || undefined}>
      {props.onOpen ? (
        <button
          type="button"
          className="att-open"
          title={`${title}\nClick to open, ⌘-click to show in Finder`}
          onClick={(e) => props.onOpen!(e.metaKey || e.ctrlKey)}
        >
          {body}
        </button>
      ) : (
        <span className="att-open" title={title}>
          {body}
        </span>
      )}
      {props.onRemove && (
        <button type="button" className="att-x" aria-label={`Remove ${name}`} title="Remove" onClick={props.onRemove}>
          <CloseIcon width={12} height={12} />
        </button>
      )}
    </span>
  );
}

// AttachmentChips: what will be sent, under the field. A path that is gone
// says so beside its chip.
export function AttachmentChips(props: { state: AttachmentsState }) {
  const { items, error, remove } = props.state;
  const missing = items.filter((x) => x.missing);
  if (items.length === 0 && !error) return null;
  return (
    <div className="att-list" data-testid="attachments">
      {items.map((x) => (
        <Chip key={x.path} item={x} onRemove={() => remove(x.path)} />
      ))}
      {missing.length > 0 && (
        <span className="att-err" role="alert">
          {missing.length === 1 ? `${attachmentName(missing[0]!.path)} is not there any more` : `${missing.length} attachments are not there any more`}; remove {missing.length === 1 ? 'it' : 'them'} or attach again.
        </span>
      )}
      {error && (
        <span className="att-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// AttachedPaths: the paths of a sent message, as chips that open the file
// (or with ⌘ show it in Finder).
export function AttachedPaths(props: { items: Attachment[]; files: Pick<ShellBridge, 'openAttachment'> }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (path: string, reveal: boolean) => {
    try {
      const msg = await props.files.openAttachment(path, reveal);
      setError(msg || null);
    } catch (err) {
      setError(cleanError(err));
    }
  };
  return (
    <div className="att-list sent" data-testid="attached">
      {props.items.map((x) => (
        <Chip key={x.path} item={x} onOpen={(reveal) => void open(x.path, reveal)} />
      ))}
      {error && (
        <span className="att-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
