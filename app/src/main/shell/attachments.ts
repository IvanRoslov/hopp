// Attachments for the page: checking paths, reading the clipboard and saving
// a pasted image. Nothing the human attaches is copied; only a pasted image
// that is not a file yet is saved, under <app home>/attachments/, and kept.
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AttachmentInfo, PasteResult } from '../../shared/attachments';

// What needs Electron, given by the main process (see main/attachments.ts).
export interface FileDeps {
  // The open dialog, files and folders, several at once; [] when cancelled.
  pick(): Promise<string[]>;
  // The file paths on the clipboard, else a PNG image without a file.
  clipboard(): Promise<{ paths: string[]; image: Buffer | null }>;
  // A small data: URL preview of an image file.
  thumb(path: string): Promise<string | undefined>;
  // Opens a path in its default app (a folder in Finder); '' or an error.
  open(path: string): Promise<string>;
  reveal(path: string): void;
}

// pathsFromUriList reads the file:// lines of a text/uri-list.
export function pathsFromUriList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith('file://')) continue;
    try {
      const u = new URL(l);
      if (u.host && u.host !== 'localhost') continue;
      out.push(decodeURIComponent(u.pathname));
    } catch {
      // not a URL; skip it
    }
  }
  return out;
}

// pathsFromFilenames reads macOS's NSFilenamesPboardType, a plist array of
// absolute paths.
export function pathsFromFilenames(plist: string): string[] {
  const out: string[] = [];
  for (const m of plist.matchAll(/<string>([^<]*)<\/string>/g)) {
    const p = m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    if (p.startsWith('/')) out.push(p);
  }
  return out;
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const MAX = 100;

function stamp(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class Attachments {
  constructor(
    private readonly files: FileDeps | undefined,
    // Where pasted images are saved: <app home>/attachments.
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private need(): FileDeps {
    if (!this.files) throw new Error('attachments are not available here');
    return this.files;
  }

  // describe checks each absolute path: a folder or not, gone or not, and a
  // preview for an image file. A path that is not absolute is reported
  // missing.
  async describe(paths: readonly string[]): Promise<AttachmentInfo[]> {
    const out: AttachmentInfo[] = [];
    for (const raw of paths.slice(0, MAX)) {
      const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
      if (!isAbsolute(path)) {
        out.push({ path, dir: false, missing: true });
        continue;
      }
      try {
        const st = await stat(path);
        const info: AttachmentInfo = { path, dir: st.isDirectory() };
        if (!info.dir && IMAGE.test(path) && this.files) {
          const thumb = await this.files.thumb(path);
          if (thumb) info.thumb = thumb;
        }
        out.push(info);
      } catch {
        out.push({ path, dir: raw.endsWith('/'), missing: true });
      }
    }
    return out;
  }

  async pick(): Promise<AttachmentInfo[]> {
    return this.describe(await this.need().pick());
  }

  async paste(): Promise<PasteResult> {
    const { paths, image } = await this.need().clipboard();
    if (paths.length) return { kind: 'files', items: await this.describe(paths) };
    if (image && image.length) {
      await mkdir(this.dir, { recursive: true });
      const path = join(this.dir, `pasted-${stamp(this.now())}-${randomBytes(3).toString('hex')}.png`);
      await writeFile(path, image, { flag: 'wx' });
      return { kind: 'image', items: await this.describe([path]) };
    }
    return { kind: 'none', items: [] };
  }

  // open opens the path, or with reveal shows it in Finder. A path that is
  // gone answers with a message instead.
  async open(path: string, reveal: boolean): Promise<string> {
    if (!isAbsolute(path)) return 'Not an absolute path';
    try {
      await stat(path);
    } catch {
      return `${path} is not there any more`;
    }
    if (reveal) {
      this.need().reveal(path);
      return '';
    }
    return this.need().open(path);
  }
}
