// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownView } from './MarkdownView.js';

const view = (markdown: string): HTMLElement => render(<MarkdownView markdown={markdown} />).container.firstElementChild as HTMLElement;

describe('MarkdownView', () => {
  it('renders headings, paragraphs and inline spans', () => {
    const el = view('# Title\n\nSome **bold**, *em* and `code`\nsecond line.\n\n### Sub');
    expect(el.querySelector('h4')?.textContent).toBe('Title');
    expect(el.querySelector('h5')?.textContent).toBe('Sub');
    expect(el.querySelector('p')?.textContent).toBe('Some bold, em and code second line.');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('em')?.textContent).toBe('em');
    expect(el.querySelector('p code')?.textContent).toBe('code');
  });

  it('renders unordered, ordered and one nesting level of lists', () => {
    const el = view('- a\n  - a1\n- b\n\n1. one\n2. two');
    expect(el.querySelectorAll('ul > li')).toHaveLength(3);
    expect(el.querySelector('ul ul li')?.textContent).toBe('a1');
    expect([...el.querySelectorAll('ol > li')].map((n) => n.textContent)).toEqual(['one', 'two']);
  });

  it('renders a fenced code block verbatim, markup included', () => {
    const el = view('```ts\nconst a = **x**;\n<b>y</b>\n```\nafter');
    expect(el.querySelector('pre code')?.textContent).toBe('const a = **x**;\n<b>y</b>');
    expect(el.querySelector('pre b')).toBeNull();
    expect(el.querySelector('p')?.textContent).toBe('after');
  });

  it('links an http(s) URL through safeUrl and strips the query', () => {
    const a = view('[docs](https://example.com/a?token=1)').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/a');
    expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('renders a link with an unsafe URL as plain text', () => {
    const el = view('[click](javascript:alert(1)) and [file](file:///etc/passwd)');
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('click');
    expect(el.innerHTML).not.toContain('javascript:');
  });

  it('never turns HTML or script input into elements', () => {
    const el = view('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n- <b>x</b>');
    expect(el.querySelector('script, img, b')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders the design-constraints items as chips', () => {
    const el = view('## Design constraints\n- @ui:UI-R39\n- 0b5696078a6\n\n## Other\n- plain');
    expect([...el.querySelectorAll('.mdChips > li')].map((n) => n.textContent)).toEqual(['@ui:UI-R39', '0b5696078a6']);
    expect(el.querySelectorAll('.mdChips')).toHaveLength(1);
  });

  it('renders nothing for an empty text', () => {
    expect(view('').children).toHaveLength(0);
  });

  it('strips closing hashes and spaces from a heading', () => {
    expect(view('# Title ##  ').querySelector('h4')?.textContent).toBe('Title');
    expect(view('# ##').querySelector('h4')?.textContent).toBe('');
  });

  it('parses a heading line of many spaces and hashes in linear time', () => {
    const hostile = `# a${' #'.repeat(20000)}x${' '.repeat(20000)}y`;
    const start = Date.now();
    view(hostile);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('renders the inline spans of a closed run', () => {
    const el = view('a `c` **b** *e* [l](https://x.test/p)');
    expect(el.querySelector('code')?.textContent).toBe('c');
    expect(el.querySelector('strong')?.textContent).toBe('b');
    expect(el.querySelector('em')?.textContent).toBe('e');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://x.test/p');
  });

  it.each(['`', '**', '*a', '[a'])('scans an unclosed %s opener run in bounded time', (opener) => {
    const start = Date.now();
    view(opener.repeat(60000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
