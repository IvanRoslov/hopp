import { describe, expect, it } from 'vitest';
import { attachmentName, onlyNames, splitAttachments, withAttachments } from './attachments';

describe('withAttachments', () => {
  it('adds the Attached block after the text, a folder ending with /', () => {
    expect(withAttachments('Look at these', [{ path: '/a/b.txt', dir: false }, { path: '/a/dir', dir: true }])).toBe(
      'Look at these\n\nAttached:\n- /a/b.txt\n- /a/dir/',
    );
  });

  it('returns the trimmed text when nothing is attached', () => {
    expect(withAttachments('  hi \n', [])).toBe('hi');
  });

  it('is the block alone when there is no text', () => {
    expect(withAttachments('   ', [{ path: '/x.png', dir: false }])).toBe('Attached:\n- /x.png');
  });

  it('does not double the slash of a folder path given with one', () => {
    expect(withAttachments('', [{ path: '/a/dir/', dir: true }])).toBe('Attached:\n- /a/dir/');
  });
});

describe('splitAttachments', () => {
  it('reads back what withAttachments wrote', () => {
    const items = [
      { path: '/a/b.txt', dir: false },
      { path: '/a/my dir', dir: true },
    ];
    expect(splitAttachments(withAttachments('Line one\nline two', items))).toEqual({ text: 'Line one\nline two', items });
  });

  it('reads a block with no text before it', () => {
    expect(splitAttachments('Attached:\n- /x.png')).toEqual({ text: '', items: [{ path: '/x.png', dir: false }] });
  });

  it('leaves a body without a block alone', () => {
    expect(splitAttachments('Just text\n- /not/a/block')).toEqual({ text: 'Just text\n- /not/a/block', items: [] });
  });

  it('takes only a block at the very end, after a blank line', () => {
    const body = 'Attached:\n- /early.txt\n\nmore words after it';
    expect(splitAttachments(body)).toEqual({ text: body, items: [] });
    expect(splitAttachments('text\nAttached:\n- /a')).toEqual({ text: 'text\nAttached:\n- /a', items: [] });
  });

  it('ignores a block with a line that is not an absolute path', () => {
    const body = 'x\n\nAttached:\n- /a\n- relative/b';
    expect(splitAttachments(body)).toEqual({ text: body, items: [] });
  });

  it('tolerates trailing whitespace and CRLF', () => {
    expect(splitAttachments('hi\r\n\r\nAttached:\r\n- /a/b \r\n')).toEqual({ text: 'hi', items: [{ path: '/a/b', dir: false }] });
  });

  it('keeps the root folder as /', () => {
    expect(splitAttachments('Attached:\n- /')).toEqual({ text: '', items: [{ path: '/', dir: true }] });
  });
});

describe('attachmentName', () => {
  it('is the last part of the path', () => {
    expect(attachmentName('/a/b/c.txt')).toBe('c.txt');
    expect(attachmentName('/a/b/dir/')).toBe('dir');
    expect(attachmentName('/')).toBe('/');
  });
});

describe('onlyNames', () => {
  it('is true when the text is just the names of the pasted files (as Finder puts them)', () => {
    expect(onlyNames('a.txt\ra folder', ['/x/a.txt', '/x/a folder'])).toBe(true);
    expect(onlyNames('a.txt\n', ['/x/a.txt'])).toBe(true);
  });

  it('is false for other text, or no text', () => {
    expect(onlyNames('please read a.txt', ['/x/a.txt'])).toBe(false);
    expect(onlyNames('', ['/x/a.txt'])).toBe(false);
  });
});
