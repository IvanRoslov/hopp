// Markdown: agent-written markdown as formatted text. marked only parses
// (GFM: tables, task lists, strikethrough); the React tree is built here from
// its tokens, so no HTML string ever reaches the page. Raw HTML in the text
// shows as text. Links open in the system browser only for https (the
// window's open handler); a link to another artifact opens it in the viewer
// when the caller can resolve it; anything else stays plain text. Images load
// only from hopp-artifact:, data:image/ or a resolved artifact — never from
// the network.
import { Lexer, type Token, type Tokens } from 'marked';
import { Fragment, useMemo, type ReactNode } from 'react';
import './markdown.css';

export interface MarkdownLinks {
  // An artifact the reference names (`name@version`, `name`, `./file.md`):
  // its file's URL for an image, and how to open it for a link. null when the
  // reference names none.
  artifact?: (ref: string) => { url: string; open: () => void } | null;
}

export function Markdown(props: { text: string; variant?: 'doc' | 'compact'; links?: MarkdownLinks; className?: string; testId?: string }) {
  const variant = props.variant ?? 'doc';
  // compact (the feed): a single newline is a line break, as in a chat.
  const tokens = useMemo(() => Lexer.lex(props.text, { gfm: true, breaks: variant === 'compact' }), [props.text, variant]);
  const ctx: Ctx = { links: props.links ?? {} };
  return (
    <div className={`md md-${variant}` + (props.className ? ' ' + props.className : '')} data-testid={props.testId}>
      {blocks(tokens, ctx)}
    </div>
  );
}

interface Ctx {
  links: MarkdownLinks;
}

function blocks(tokens: Token[], ctx: Ctx): ReactNode {
  return tokens.map((t, i) => <Fragment key={i}>{block(t, ctx)}</Fragment>);
}

function block(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading': {
      const h = t as Tokens.Heading;
      const Tag = `h${Math.min(Math.max(h.depth, 1), 6)}` as 'h1';
      return <Tag>{inline(h.tokens, ctx)}</Tag>;
    }
    case 'paragraph':
      return <p>{inline((t as Tokens.Paragraph).tokens, ctx)}</p>;
    case 'text': {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : decode(x.text);
    }
    case 'code': {
      const c = t as Tokens.Code;
      const lang = (c.lang ?? '').trim().split(/\s+/)[0] ?? '';
      return (
        <figure className="md-code">
          {lang && <figcaption>{lang}</figcaption>}
          <pre>
            <code>{c.text}</code>
          </pre>
        </figure>
      );
    }
    case 'blockquote':
      return <blockquote>{blocks((t as Tokens.Blockquote).tokens, ctx)}</blockquote>;
    case 'list': {
      const l = t as Tokens.List;
      const items = l.items.map((it, i) => <li key={i} className={it.task ? 'md-task' : undefined}>{listItem(it, ctx)}</li>);
      return l.ordered ? <ol start={typeof l.start === 'number' && l.start !== 1 ? l.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const align = (i: number) => tb.align[i] ?? undefined;
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {tb.header.map((c, i) => (
                  <th key={i} style={align(i) ? { textAlign: align(i)! } : undefined}>
                    {inline(c.tokens, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, i) => (
                    <td key={i} style={align(i) ? { textAlign: align(i)! } : undefined}>
                      {inline(c.tokens, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr />;
    case 'html':
      // Raw HTML is shown as the text it is, never run.
      return <p className="md-raw">{(t as Tokens.HTML).text.trim()}</p>;
    default:
      return 'raw' in t && typeof t.raw === 'string' ? <p>{t.raw}</p> : null;
  }
}

function listItem(it: Tokens.ListItem, ctx: Ctx): ReactNode {
  return (
    <>
      {it.task && <input type="checkbox" className="md-check" checked={!!it.checked} disabled readOnly aria-label={it.checked ? 'done' : 'not done'} />}
      {blocks(it.tokens.filter((x) => x.type !== 'checkbox'), ctx)}
    </>
  );
}

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => <Fragment key={i}>{span(t, ctx)}</Fragment>);
}

function span(t: Token, ctx: Ctx): ReactNode {
  switch (t.type) {
    case 'text': {
      const x = t as Tokens.Text;
      return x.tokens ? inline(x.tokens, ctx) : decode(x.text);
    }
    case 'escape':
      return decode((t as Tokens.Escape).text);
    case 'strong':
      return <strong>{inline((t as Tokens.Strong).tokens, ctx)}</strong>;
    case 'em':
      return <em>{inline((t as Tokens.Em).tokens, ctx)}</em>;
    case 'del':
      return <del>{inline((t as Tokens.Del).tokens, ctx)}</del>;
    case 'codespan':
      return <code>{(t as Tokens.Codespan).text}</code>;
    case 'br':
      return <br />;
    case 'link':
      return link(t as Tokens.Link, ctx);
    case 'image':
      return image(t as Tokens.Image, ctx);
    case 'html':
      return (t as Tokens.Tag).text;
    case 'checkbox':
      return null;
    default:
      return 'raw' in t && typeof t.raw === 'string' ? t.raw : null;
  }
}

function link(l: Tokens.Link, ctx: Ctx): ReactNode {
  const children = inline(l.tokens, ctx);
  const href = l.href.trim();
  if (/^https:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" title={l.title ?? href}>
        {children}
      </a>
    );
  }
  const art = isLocalRef(href) ? ctx.links.artifact?.(href) : null;
  if (art) {
    return (
      <button type="button" className="md-link" title={href} onClick={art.open}>
        {children}
      </button>
    );
  }
  return (
    <span className="md-link-off" title={href}>
      {children}
    </span>
  );
}

function image(img: Tokens.Image, ctx: Ctx): ReactNode {
  const href = img.href.trim();
  let src: string | null = null;
  if (/^hopp-artifact:\/\//i.test(href) || /^data:image\//i.test(href)) src = href;
  else if (isLocalRef(href)) src = ctx.links.artifact?.(href)?.url ?? null;
  if (!src) {
    return (
      <span className="md-img-off" title={href}>
        [{img.text || 'image'}]
      </span>
    );
  }
  return <img src={src} alt={img.text} title={img.title ?? undefined} loading="lazy" />;
}

// isLocalRef: a reference without a scheme (`analysis@2`, `./chart.png`).
function isLocalRef(href: string): boolean {
  return href !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

// decode: the few HTML entities marked leaves in text, as characters.
function decode(s: string): string {
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
