// The shared attachments field: adding by the dialog, by paste and by drop,
// one chip per path, a path that is gone, and the chips of a sent message.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo, PasteResult } from '../../shared/attachments';
import { AttachButton, AttachedPaths, AttachmentChips, useAttachments } from './Attachments';

afterEach(cleanup);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function files(over: { paths?: Record<string, 'file' | 'dir'>; picks?: string[][]; pastes?: PasteResult[] } = {}) {
  const paths = { ...over.paths };
  const picks = [...(over.picks ?? [])];
  const pastes = [...(over.pastes ?? [])];
  const describe = (list: string[]): AttachmentInfo[] =>
    list.map((p) => (paths[p] ? { path: p, dir: paths[p] === 'dir' } : { path: p, dir: false, missing: true }));
  return {
    paths,
    api: {
      pickAttachments: vi.fn(async () => describe(picks.shift() ?? [])),
      pasteAttachments: vi.fn(async (): Promise<PasteResult> => pastes.shift() ?? { kind: 'none', items: [] }),
      describePaths: vi.fn(async (list: string[]) => describe(list)),
      openAttachment: vi.fn(async (_p: string, _r: boolean) => ''),
      pathForFile: vi.fn((f: File) => '/dropped/' + f.name),
    },
  };
}

// A field like the two real ones: text, the chips, the clip and a send that
// shows what would go out.
function Field(props: { f: ReturnType<typeof files>['api'] }) {
  const att = useAttachments(props.f);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div data-testid="box" onDragOver={att.field.onDragOver} onDrop={att.field.onDrop}>
      <textarea aria-label="text" value={text} onChange={(e) => setText(e.target.value)} onPaste={att.field.onPaste} />
      <AttachmentChips state={att} />
      <AttachButton onClick={() => void att.pick()} />
      <button type="button" onClick={async () => setSent((await att.check()) ? att.compose(text) : 'BLOCKED')}>
        send
      </button>
      {sent !== null && <pre data-testid="sent">{sent}</pre>}
    </div>
  );
}

const chips = () => screen.queryAllByTestId('attachments').flatMap((l) => Array.from(l.querySelectorAll<HTMLElement>('.att-chip')));
const paste = (text: string) => fireEvent.paste(screen.getByLabelText('text'), { clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : '') } });

describe('useAttachments', () => {
  it('attaches files and folders from the dialog, once per path, and sends them as the Attached block', async () => {
    const f = files({ paths: { '/a/notes.md': 'file', '/a/src': 'dir' }, picks: [['/a/notes.md', '/a/src'], ['/a/notes.md']] });
    render(<Field f={f.api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    expect(chips().map((c) => c.textContent)).toEqual(['notes.md', 'src']);
    // The full path is in the tooltip; a folder is marked as one.
    expect(within(chips()[0]!).getByTitle('/a/notes.md')).toBeTruthy();
    expect(chips()[1]!.dataset['dir']).toBe('true');
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'Read these' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await flush();
    expect(screen.getByTestId('sent').textContent).toBe('Read these\n\nAttached:\n- /a/notes.md\n- /a/src/');
  });

  it('removes a chip with its cross', async () => {
    const f = files({ paths: { '/a/x.txt': 'file', '/a/y.txt': 'file' }, picks: [['/a/x.txt', '/a/y.txt']] });
    render(<Field f={f.api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Remove x.txt' }));
    expect(chips().map((c) => c.textContent)).toEqual(['y.txt']);
  });

  it('stops the send and says so when an attached file is gone', async () => {
    const f = files({ paths: { '/a/x.txt': 'file' }, picks: [['/a/x.txt']] });
    render(<Field f={f.api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach files or folders' }));
    await flush();
    delete f.paths['/a/x.txt'];
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await flush();
    expect(screen.getByTestId('sent').textContent).toBe('BLOCKED');
    expect(screen.getByRole('alert').textContent).toMatch(/x\.txt is not there any more/);
    expect(chips()[0]!.className).toContain('missing');
  });

  it('pastes copied files as chips and drops the names Finder puts beside them', async () => {
    const f = files({ pastes: [{ kind: 'files', items: [{ path: '/a/a.txt', dir: false }, { path: '/a/a folder', dir: true }] }] });
    render(<Field f={f.api} />);
    paste('a.txt\ra folder');
    await flush();
    expect(chips().map((c) => c.textContent)).toEqual(['a.txt', 'a folder']);
    expect((screen.getByLabelText('text') as HTMLTextAreaElement).value).toBe('');
  });

  it('pastes a screenshot as the saved image and keeps text pastes as text', async () => {
    const f = files({ pastes: [{ kind: 'image', items: [{ path: '/app/attachments/pasted-1.png', dir: false, thumb: 'data:image/png;base64,AA' }] }] });
    render(<Field f={f.api} />);
    paste('');
    await flush();
    expect(chips().map((c) => c.textContent)).toEqual(['pasted-1.png']);
    expect(chips()[0]!.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA');
    // The next paste has only text: it lands in the field.
    paste('plain words');
    await flush();
    expect((screen.getByLabelText('text') as HTMLTextAreaElement).value).toBe('plain words');
    expect(chips()).toHaveLength(1);
  });

  it('attaches what is dropped on the field', async () => {
    const f = files({ paths: { '/dropped/report.pdf': 'file' } });
    render(<Field f={f.api} />);
    const file = new File(['x'], 'report.pdf');
    fireEvent.drop(screen.getByTestId('box'), { dataTransfer: { files: [file], types: ['Files'] } });
    await flush();
    expect(f.api.pathForFile).toHaveBeenCalledWith(file);
    expect(chips().map((c) => c.textContent)).toEqual(['report.pdf']);
  });
});

describe('AttachedPaths', () => {
  it('opens a sent path on click and shows it in Finder with ⌘', async () => {
    const f = files();
    render(<AttachedPaths items={[{ path: '/a/b.txt', dir: false }]} files={f.api} />);
    fireEvent.click(screen.getByRole('button', { name: /b\.txt/ }));
    fireEvent.click(screen.getByRole('button', { name: /b\.txt/ }), { metaKey: true });
    await flush();
    expect(f.api.openAttachment.mock.calls).toEqual([
      ['/a/b.txt', false],
      ['/a/b.txt', true],
    ]);
  });

  it('says why a path could not be opened', async () => {
    const f = files();
    f.api.openAttachment.mockResolvedValueOnce('/a/b.txt is not there any more');
    render(<AttachedPaths items={[{ path: '/a/b.txt', dir: false }]} files={f.api} />);
    fireEvent.click(screen.getByRole('button', { name: /b\.txt/ }));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/not there any more/);
  });
});
