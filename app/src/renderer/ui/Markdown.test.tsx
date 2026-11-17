import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

const md = (text: string, links?: Parameters<typeof Markdown>[0]['links']) => {
  const { container } = render(<Markdown text={text} links={links} />);
  return container.querySelector('.md') as HTMLElement;
};

describe('Markdown renders', () => {
  it('headings, paragraphs, emphasis, inline code and a rule', () => {
    const el = md('# Анализ\n\n## Итоги\n\nТекст с **жирным**, *курсивом*, ~~зачёркнутым~~ и `npm ci`.\n\n---\n\nДальше.');
    expect(el.querySelector('h1')!.textContent).toBe('Анализ');
    expect(el.querySelector('h2')!.textContent).toBe('Итоги');
    expect(el.querySelector('strong')!.textContent).toBe('жирным');
    expect(el.querySelector('em')!.textContent).toBe('курсивом');
    expect(el.querySelector('del')!.textContent).toBe('зачёркнутым');
    expect(el.querySelector('p code')!.textContent).toBe('npm ci');
    expect(el.querySelector('hr')).toBeTruthy();
    expect(el.querySelectorAll('p')).toHaveLength(2);
  });

  it('a fenced code block with its language, kept verbatim', () => {
    const el = md('```go\nif a < b && c {\n\treturn "&amp;"\n}\n```');
    expect(el.querySelector('.md-code figcaption')!.textContent).toBe('go');
    expect(el.querySelector('.md-code code')!.textContent).toBe('if a < b && c {\n\treturn "&amp;"\n}');
  });

  it('lists, nested lists with inline code, and task lists', () => {
    const el = md('1. Первый\n2. Второй\n   - вложенный `pnpm`\n   - ещё\n\n- [x] сделано\n- [ ] не сделано');
    const ol = el.querySelector('ol')!;
    expect(ol.children).toHaveLength(2);
    expect(ol.querySelector('ul li code')!.textContent).toBe('pnpm');
    const tasks = el.querySelectorAll<HTMLInputElement>('li.md-task input[type=checkbox]');
    expect([...tasks].map((t) => [t.checked, t.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('a GFM table, aligned, inside a scrolling box', () => {
    const el = md('| Версия | Статус |\n|:--|--:|\n| 20 LTS | **ok** |');
    const box = el.querySelector('.md-table')!;
    expect(box.querySelectorAll('th')[1]!.style.textAlign).toBe('right');
    expect(box.querySelector('tbody td strong')!.textContent).toBe('ok');
  });

  it('block quotes and entities', () => {
    const el = md('> цитата &amp; ещё\n\nA &lt; B');
    expect(el.querySelector('blockquote')!.textContent).toBe('цитата & ещё');
    expect(el.querySelectorAll('p')[1]!.textContent).toBe('A < B');
  });

  it('the compact variant breaks lines on a single newline', () => {
    const { container } = render(<Markdown variant="compact" text={'строка один\nстрока два'} />);
    expect(container.querySelector('.md-compact br')).toBeTruthy();
    const doc = md('строка один\nстрока два');
    expect(doc.querySelector('br')).toBeNull();
  });
});

describe('Markdown is safe with agent-written text', () => {
  it('raw HTML is shown as text, never as elements', () => {
    const el = md('<script>alert(1)</script>\n\nДо <img src=x onerror="alert(2)"> после <b>жирно</b>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.textContent).toContain('onerror="alert(2)"');
    expect(el.querySelectorAll('[onerror]')).toHaveLength(0);
    expect(el.innerHTML).not.toMatch(/<script/);
  });

  it('a javascript:, file: or http: link is plain text; https opens outside', () => {
    const el = md('[a](javascript:alert(1)) [b](file:///etc/passwd) [c](http://example.com) [d](https://example.com/x)');
    const anchors = el.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/x');
    expect(anchors[0]!.getAttribute('target')).toBe('_blank');
    expect(anchors[0]!.getAttribute('rel')).toContain('noopener');
    expect([...el.querySelectorAll('.md-link-off')].map((s) => s.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('a remote image is not loaded; hopp-artifact: and data:image are', () => {
    const el = md('![remote](https://evil.example/p.png) ![a](hopp-artifact://v/3) ![d](data:image/png;base64,AAAA)');
    const srcs = [...el.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['hopp-artifact://v/3', 'data:image/png;base64,AAAA']);
    expect(el.querySelector('.md-img-off')!.textContent).toBe('[remote]');
  });

  it('a link or image naming another artifact resolves through the caller', () => {
    const open = vi.fn();
    const el = md('См. [анализ](analysis@2) и ![график](./chart.png), а [нет такого](missing@1).', {
      artifact: (ref) => (ref === 'analysis@2' || ref === './chart.png' ? { url: 'hopp-artifact://v/9', open } : null),
    });
    fireEvent.click(screen.getByRole('button', { name: 'анализ' }));
    expect(open).toHaveBeenCalled();
    expect(el.querySelector('img')!.getAttribute('src')).toBe('hopp-artifact://v/9');
    expect(el.querySelector('.md-link-off')!.textContent).toBe('нет такого');
  });
});
