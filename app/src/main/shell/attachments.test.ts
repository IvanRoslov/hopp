import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attachments, pathsFromFilenames, pathsFromUriList, type FileDeps } from './attachments';

// What the clipboard held when files were put on it the way Finder does
// (NSPasteboard writeObjects of file URLs), read through Electron 45's
// clipboard.read() on 2026-11-18.
const URI_LIST = 'file:///tmp/clip/a.txt\r\nfile:///tmp/clip/a%20folder/\r\n';
const FILENAMES = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<string>/tmp/clip/a.txt</string>
	<string>/tmp/clip/Tom &amp; Jerry</string>
</array>
</plist>
`;

describe('clipboard formats', () => {
  it('reads the paths of a text/uri-list, decoding them', () => {
    expect(pathsFromUriList(URI_LIST)).toEqual(['/tmp/clip/a.txt', '/tmp/clip/a folder/']);
  });

  it('skips lines that are not local file URLs', () => {
    expect(pathsFromUriList('https://example.com/x\nfile://server/share/x\n# comment\nfile:///ok')).toEqual(['/ok']);
  });

  it('reads the paths of NSFilenamesPboardType', () => {
    expect(pathsFromFilenames(FILENAMES)).toEqual(['/tmp/clip/a.txt', '/tmp/clip/Tom & Jerry']);
  });
});

describe('Attachments', () => {
  let dir: string;
  let files: FileDeps;
  let a: Attachments;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopp-att-'));
    await writeFile(join(dir, 'a.txt'), 'hi');
    await writeFile(join(dir, 'shot.png'), 'png');
    await mkdir(join(dir, 'folder'));
    files = {
      pick: vi.fn(async () => [join(dir, 'a.txt'), join(dir, 'folder')]),
      clipboard: vi.fn(async () => ({ paths: [] as string[], image: null as Buffer | null })),
      thumb: vi.fn(async () => 'data:image/png;base64,AAA'),
      open: vi.fn(async () => ''),
      reveal: vi.fn(),
    };
    a = new Attachments(files, join(dir, 'app', 'attachments'), () => new Date(2026, 10, 18, 9, 5, 7).getTime());
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('describes files, folders, missing paths and relative paths', async () => {
    expect(await a.describe([join(dir, 'a.txt'), join(dir, 'folder') + '/', join(dir, 'gone'), 'rel/x'])).toEqual([
      { path: join(dir, 'a.txt'), dir: false },
      { path: join(dir, 'folder'), dir: true },
      { path: join(dir, 'gone'), dir: false, missing: true },
      { path: 'rel/x', dir: false, missing: true },
    ]);
  });

  it('gives an image a preview', async () => {
    expect(await a.describe([join(dir, 'shot.png')])).toEqual([{ path: join(dir, 'shot.png'), dir: false, thumb: 'data:image/png;base64,AAA' }]);
  });

  it('picks through the dialog', async () => {
    expect((await a.pick()).map((x) => x.dir)).toEqual([false, true]);
  });

  it('pastes copied files as their paths and never saves the image beside them', async () => {
    files.clipboard = vi.fn(async () => ({ paths: [join(dir, 'a.txt')], image: Buffer.from('icon') }));
    expect(await a.paste()).toEqual({ kind: 'files', items: [{ path: join(dir, 'a.txt'), dir: false }] });
    await expect(readdir(join(dir, 'app'))).rejects.toThrow();
  });

  it('saves a pasted image without a file under the attachments folder and keeps it', async () => {
    files.clipboard = vi.fn(async () => ({ paths: [], image: Buffer.from('PNGDATA') }));
    const r = await a.paste();
    expect(r.kind).toBe('image');
    const p = r.items[0]!.path;
    expect(p.startsWith(join(dir, 'app', 'attachments', 'pasted-20261118-090507-'))).toBe(true);
    expect(p.endsWith('.png')).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('PNGDATA');
    // A second paste in the same second gets its own file.
    const r2 = await a.paste();
    expect(r2.items[0]!.path).not.toBe(p);
  });

  it('leaves a text paste to the page', async () => {
    expect(await a.paste()).toEqual({ kind: 'none', items: [] });
  });

  it('opens or reveals a path that exists, and says so for one that is gone', async () => {
    expect(await a.open(join(dir, 'a.txt'), false)).toBe('');
    expect(files.open).toHaveBeenCalledWith(join(dir, 'a.txt'));
    expect(await a.open(join(dir, 'folder'), true)).toBe('');
    expect(files.reveal).toHaveBeenCalledWith(join(dir, 'folder'));
    expect(await a.open(join(dir, 'gone'), false)).toMatch(/not there any more/);
  });
});
