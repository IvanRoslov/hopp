// plainLine: agent-written markdown as one line of plain text, for the rows
// and tooltips that show an ask or a post in a single line ("Waiting for
// you", the answered rows of the Questions column). The marks go (`**`,
// backticks, heading marks, list dashes, link syntax → the link's text,
// an image → its alt text); what a code span holds stays as written, even
// asterisks. The line is the first line with text of the first block that
// has any, as the rows showed it before. The row cuts it with an ellipsis.
import { Lexer, type Token, type Tokens } from 'marked';

export function plainLine(markdown: string): string {
  const blocks = Lexer.lex(markdown, { gfm: true });
  for (const b of blocks) {
    const first = b.type === 'list' ? (b as Tokens.List).items[0] : b;
    const line = firstLine(first ? plain(first) : '');
    if (line) return line;
  }
  return firstLine(markdown);
}

// firstLine: the first line that has text, spaces collapsed.
function firstLine(s: string): string {
  return squash(s.split('\n').find((l) => l.trim()) ?? '');
}

function plain(t: Token): string {
  switch (t.type) {
    case 'space':
    case 'hr':
    case 'def':
    case 'checkbox':
    case 'br':
      return ' ';
    case 'codespan':
      return (t as Tokens.Codespan).text;
    case 'code':
      return (t as Tokens.Code).text;
    case 'escape':
      return decode((t as Tokens.Escape).text);
    case 'image':
      return (t as Tokens.Image).text;
    case 'list':
      return (t as Tokens.List).items.map(plain).join('; ');
    case 'table': {
      const tb = t as Tokens.Table;
      return tb.header.map((c) => c.tokens.map(plain).join('')).join(' · ');
    }
    case 'html':
      return (t as Tokens.HTML).text;
  }
  if ('tokens' in t && Array.isArray(t.tokens)) return (t.tokens as Token[]).map(plain).join('');
  if ('text' in t && typeof t.text === 'string') return decode(t.text);
  return 'raw' in t && typeof t.raw === 'string' ? t.raw : '';
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

// decode: the few HTML entities marked leaves in text, as characters.
export function decode(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k]!;
    if (k.startsWith('#x')) return safeChar(parseInt(k.slice(2), 16), m);
    if (k.startsWith('#')) return safeChar(parseInt(k.slice(1), 10), m);
    return m;
  });
}

function safeChar(code: number, fallback: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}
