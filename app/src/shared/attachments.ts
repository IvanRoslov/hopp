// Attachments: files and folders the human attaches to a new task or to a
// line in a task's feed. Nothing is copied: an attachment is an absolute
// path the agent reads itself. On the way out the paths go at the end of
// the text as one block,
//
//   Attached:
//   - /abs/path/file.txt
//   - /abs/path/folder/
//
// so the daemon and the agent see plain text; the feed reads the block back
// to draw the paths as chips.

export interface Attachment {
  // Absolute path, without a trailing slash (except the root, "/").
  path: string;
  dir: boolean;
}

// What the main process tells the page about a path.
export interface AttachmentInfo extends Attachment {
  // The path does not exist (any more).
  missing?: boolean;
  // A small data: URL preview of an image file, when one could be made.
  thumb?: string;
}

// What a paste attaches.
export type PasteResult =
  // Files and folders copied (in Finder): their paths.
  | { kind: 'files'; items: AttachmentInfo[] }
  // An image without a file (a screenshot to the clipboard): saved, and its
  // new path.
  | { kind: 'image'; items: AttachmentInfo[] }
  // Nothing to attach; the page pastes the text itself.
  | { kind: 'none'; items: [] };

const HEADER = 'Attached:';

function bare(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function line(a: Attachment): string {
  const p = bare(a.path);
  return '- ' + (a.dir && p !== '/' ? p + '/' : p);
}

// withAttachments: the text, trimmed, then a blank line and the block; the
// block alone when there is no text; the text alone when nothing is attached.
export function withAttachments(text: string, items: readonly Attachment[]): string {
  const t = text.trim();
  if (items.length === 0) return t;
  const block = [HEADER, ...items.map(line)].join('\n');
  return t ? t + '\n\n' + block : block;
}

// splitAttachments reads a block back from the end of a body. Only a block
// that ends the body, starts it or follows a blank line, and lists only
// absolute paths counts; anything else is left as text.
export function splitAttachments(body: string): { text: string; items: Attachment[] } {
  const lines = body.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  let i = lines.length - 1;
  const items: Attachment[] = [];
  while (i >= 0 && /^- \//.test(lines[i]!)) {
    const raw = lines[i]!.slice(2).trimEnd();
    const dir = raw.endsWith('/');
    items.unshift({ path: bare(raw), dir });
    i--;
  }
  if (items.length === 0 || i < 0 || lines[i]!.trim() !== HEADER || (i > 0 && lines[i - 1]!.trim() !== '')) {
    return { text: body, items: [] };
  }
  return { text: lines.slice(0, i).join('\n').trim(), items };
}

// attachmentName is what a chip shows: the last part of the path.
export function attachmentName(path: string): string {
  const p = bare(path);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

// onlyNames: the pasted text is nothing but the names of the pasted files,
// which is what Finder puts beside the files themselves. Such text is not
// pasted.
export function onlyNames(text: string, paths: readonly string[]): boolean {
  const parts = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  const names = new Set(paths.map(attachmentName));
  return parts.every((p) => names.has(p));
}
