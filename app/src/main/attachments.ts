// The parts of attachments that need Electron: the open dialog, the system
// clipboard, image previews and opening a path. ShellService holds the
// rest (checking paths, saving a pasted image) and gets these as deps.
import { BrowserWindow, clipboard, dialog, nativeImage, shell } from 'electron';
import { pathsFromFilenames, pathsFromUriList, type FileDeps } from './shell/attachments';

const FILENAMES = 'electron application/osclipboard;format="NSFilenamesPboardType"';

async function blobText(b: unknown): Promise<string> {
  if (typeof b === 'string') return b;
  return b instanceof Blob ? b.text() : '';
}

// readClipboard: the file paths on the clipboard (Finder puts every copied
// file and folder there, with their names as text and an icon image); else
// a PNG image without a file (a screenshot taken to the clipboard).
async function readClipboard(): Promise<{ paths: string[]; image: Buffer | null }> {
  const items = await clipboard.read();
  let image: Buffer | null = null;
  for (const it of items) {
    if (it.types.includes('text/uri-list')) {
      const paths = pathsFromUriList(await blobText(await it.getType('text/uri-list')));
      if (paths.length) return { paths, image: null };
    }
    if (it.types.includes(FILENAMES)) {
      const paths = pathsFromFilenames(await blobText(await it.getType(FILENAMES)));
      if (paths.length) return { paths, image: null };
    }
    if (!image && it.types.includes('image/png')) {
      const b = await it.getType('image/png');
      if (b instanceof Blob) image = Buffer.from(await b.arrayBuffer());
    }
  }
  return { paths: [], image };
}

export const electronFiles: FileDeps = {
  pick: async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    type Prop = 'openFile' | 'openDirectory' | 'multiSelections' | 'treatPackageAsDirectory';
    const opts = { title: 'Attach files or folders', buttonLabel: 'Attach', properties: ['openFile', 'openDirectory', 'multiSelections'] as Prop[] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : r.filePaths;
  },
  clipboard: readClipboard,
  thumb: async (path) => {
    try {
      const img = await nativeImage.createThumbnailFromPath(path, { width: 96, height: 96 });
      return img.isEmpty() ? undefined : img.toDataURL();
    } catch {
      return undefined;
    }
  },
  open: (path) => shell.openPath(path),
  reveal: (path) => shell.showItemInFolder(path),
};
