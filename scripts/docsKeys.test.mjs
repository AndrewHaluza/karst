import { describe, expect, it } from 'vitest';
import { buildIndex, lintDoc, MAX_BLOCK_BYTES } from './docsKeys.mjs';

const header = (p) => `<!-- AGENT INSTRUCTIONS:
1. TOC:
  grep -F "## [@" ${p}
2. EXTRACT:
  awk "/^## \\[@a:X\\]/,/END_DOC_BLOCK: \\[@a:X\\]/" ${p}
-->
`;
const block = (id, body = 'text') => `## [@${id}] Title ${id}\n${body}\nEND_DOC_BLOCK: [@${id}]\n`;
const doc = (p, ...blocks) => ({ path: p, text: header(p) + '\n' + blocks.join('\n') });

describe('lintDoc', () => {
  it('accepts a well-formed doc', () => {
    expect(lintDoc(doc('docs/a.md', block('a:A-01'), block('a:A-02')))).toEqual([]);
  });

  it('flags missing header', () => {
    const errs = lintDoc({ path: 'docs/a.md', text: block('a:A-01') });
    expect(errs.join()).toMatch(/missing AGENT INSTRUCTIONS/);
  });

  it('flags the <file_path> placeholder', () => {
    const d = { path: 'docs/a.md', text: header('<file_path>') + block('a:A-01') };
    expect(lintDoc(d).join()).toMatch(/placeholder/);
  });

  it('flags a header path that names another file', () => {
    const d = { path: 'docs/a.md', text: header('docs/b.md') + block('a:A-01') };
    expect(lintDoc(d).join()).toMatch(/header path docs\/b\.md/);
  });

  it('flags duplicate ids', () => {
    expect(lintDoc(doc('docs/a.md', block('a:A-01'), block('a:A-01'))).join()).toMatch(/duplicate/);
  });

  it('flags a missing or mismatched end marker', () => {
    const open = '## [@a:A-01] T\nbody\n';
    expect(lintDoc(doc('docs/a.md', open)).join()).toMatch(/A-01.*no END/);
    const bad = '## [@a:A-01] T\nbody\nEND_DOC_BLOCK: [@a:A-02]\n';
    expect(lintDoc(doc('docs/a.md', bad)).join()).toMatch(/mismatch/);
  });

  it('flags an unkeyed ## heading but ignores fenced code', () => {
    const inner = '```md\n## Not a heading\n```\n## Bare\n';
    const errs = lintDoc(doc('docs/a.md', block('a:A-01', inner)));
    expect(errs.filter((e) => /unkeyed/.test(e))).toHaveLength(1);
  });

  it('flags oversized blocks', () => {
    const big = 'x'.repeat(MAX_BLOCK_BYTES + 1);
    expect(lintDoc(doc('docs/a.md', block('a:A-01', big))).join()).toMatch(/exceeds/);
  });
});

describe('lintDoc edge cases', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    const wide = '—'.repeat(Math.ceil(MAX_BLOCK_BYTES / 3));
    expect(lintDoc(doc('docs/a.md', block('a:A-01', wide))).join()).toMatch(/exceeds/);
  });

  it('ignores ## and END lines inside indented, tilde and longer fences', () => {
    const inner = '  ```md\n  ## x\n  ```\n~~~\n## y\nEND_DOC_BLOCK: [@a:ZZ]\n~~~\n````md\n```\n## z\n````';
    expect(lintDoc(doc('docs/a.md', block('a:A-01', inner)))).toEqual([]);
  });

  it('accepts CRLF files', () => {
    const d = doc('docs/a.md', block('a:A-01'));
    expect(lintDoc({ ...d, text: d.text.replace(/\n/g, '\r\n') })).toEqual([]);
  });

  it('allows cross-reference .md paths in prose of the header', () => {
    const d = doc('docs/a.md', block('a:A-01'));
    const text = d.text.replace('1. TOC:', '1. TOC (see docs/glossary.md):');
    expect(lintDoc({ ...d, text })).toEqual([]);
  });
});

describe('buildIndex', () => {
  it('orders paths by code unit, independent of locale', () => {
    const out = buildIndex([doc('docs/B.md', block('b:B-01')), doc('docs/a.md', block('a:A-01'))]);
    expect(out.indexOf('docs/B.md')).toBeLessThan(out.indexOf('docs/a.md'));
  });

  it('lists key, file and title, one line per block, sorted by path', () => {
    const out = buildIndex([doc('docs/b.md', block('b:B-01')), doc('docs/a.md', block('a:A-01'))]);
    const lines = out.split('\n').filter((l) => l.startsWith('[@'));
    expect(lines).toEqual([
      '[@a:A-01] docs/a.md — Title a:A-01',
      '[@b:B-01] docs/b.md — Title b:B-01',
    ]);
  });
});
