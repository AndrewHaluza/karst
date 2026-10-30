import { describe, expect, it } from 'vitest';
import {
  buildCovers,
  buildIndex,
  collectRefSources,
  coversJson,
  coversStale,
  keyIndex,
  lintCovers,
  lintDoc,
  lintRefs,
  MAX_BLOCK_BYTES,
  symbolRange,
} from './docsKeys.mjs';

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

  it('indexes @issue: keys from docs/issues/', () => {
    const out = buildIndex([doc('docs/issues/2026-01-01-x.md', block('issue:X-01'))]);
    expect(out).toContain('[@issue:X-01] docs/issues/2026-01-01-x.md — Title issue:X-01');
  });
});

describe('lintRefs', () => {
  const src = (path, text) => ({ path, text });

  it('accepts a bare reference to a key defined in exactly one doc', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    expect(lintRefs([src('src/x.ts', '// see @arch:A-01')], index)).toEqual([]);
  });

  it('flags a reference to a key no doc defines', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    const errs = lintRefs([src('src/x.ts', '// see @arch:NOPE')], index);
    expect(errs.join()).toMatch(/src\/x\.ts:1: unresolved reference @arch:NOPE/);
  });

  it('flags a bare reference to a key defined in more than one doc', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:CONTENTS')), doc('docs/arch/b.md', block('arch:CONTENTS'))]);
    const errs = lintRefs([src('docs/arch/c.md', 'see @arch:CONTENTS')], index);
    expect(errs.join()).toMatch(/ambiguous reference @arch:CONTENTS \(defined in 2 files/);
  });

  it('accepts a qualified reference to a key defined in more than one doc', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:CONTENTS')), doc('docs/arch/b.md', block('arch:CONTENTS'))]);
    expect(lintRefs([src('docs/arch/c.md', 'see docs/arch/a.md#@arch:CONTENTS')], index)).toEqual([]);
  });

  it('flags a qualified reference naming a doc that does not define the key', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    const errs = lintRefs([src('docs/arch/c.md', 'see docs/arch/b.md#@arch:A-01')], index);
    expect(errs.join()).toMatch(/unresolved reference docs\/arch\/b\.md#@arch:A-01/);
  });

  it('does not treat a block definition or the header recipe as a reference', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:CONTENTS')), doc('docs/arch/b.md', block('arch:CONTENTS'))]);
    expect(lintRefs([doc('docs/arch/a.md', block('arch:CONTENTS'))], index)).toEqual([]);
  });

  it('skips the @arch:KEY metavariable and fenced code', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    const text = 'see `@arch:KEY`\n```\n@arch:NOPE\n```\n';
    expect(lintRefs([src('docs/x.md', text)], index)).toEqual([]);
  });

  it('checks a reference sitting in a block-definition heading title', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    const text = '## [@arch:A-01] see also @arch:NOPE\nbody\nEND_DOC_BLOCK: [@arch:A-01]\n';
    expect(lintRefs([src('docs/x.md', text)], index).join()).toMatch(/unresolved reference @arch:NOPE/);
  });

  it('accepts a qualified reference written with a leading ./', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    expect(lintRefs([src('docs/x.md', 'see ./docs/arch/a.md#@arch:A-01')], index)).toEqual([]);
  });

  it('checks references in working notes (docs/plans, docs/superpowers)', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    const errs = lintRefs([src('docs/plans/2026-01-01-x.md', 'see @arch:NOPE')], index);
    expect(errs.join()).toMatch(/unresolved reference @arch:NOPE/);
  });

  it('checks references in every namespace a doc defines, not only arch and issue', () => {
    const index = keyIndex([doc('docs/ui/a.md', block('ui:U-01')), doc('docs/glossary.md', block('gloss:GL-01'))]);
    const errs = lintRefs([src('docs/x.md', 'see @ui:U-01, @ui:NOPE and @gloss:GL-99')], index);
    expect(errs).toEqual([
      'docs/x.md:1: unresolved reference @ui:NOPE',
      'docs/x.md:1: unresolved reference @gloss:GL-99',
    ]);
  });

  it('accepts a key with dotted parts, and does not take a trailing period as part of it', () => {
    const index = keyIndex([doc('docs/ui/d.md', block('ui:12.7'))]);
    expect(lintRefs([src('docs/x.md', 'see @ui:12.7, and @ui:12.7.')], index)).toEqual([]);
  });

  it('ignores an @word:token whose namespace no doc defines', () => {
    const index = keyIndex([doc('docs/arch/a.md', block('arch:A-01'))]);
    expect(lintRefs([src('docs/x.md', 'see `@ns:ID` and npm:@types/node@1')], index)).toEqual([]);
  });
});

describe('collectRefSources', () => {
  it('covers docs/plans, docs/superpowers and src/, which the format lint skips', () => {
    const paths = collectRefSources().map((s) => s.path);
    expect(paths.some((p) => p.startsWith('docs/plans/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('docs/superpowers/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('src/'))).toBe(true);
  });

  it('covers the root CLAUDE.md, the entry point into the docs', () => {
    expect(collectRefSources().map((s) => s.path)).toContain('CLAUDE.md');
  });
});

describe('lintDoc -00 overview', () => {
  const good = [
    '### Purpose',
    'One sentence.',
    '',
    '### Connections',
    '- in: x',
    '- out: y',
    '',
    '### Flow',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
  ].join('\n');

  it('accepts a well-formed -00 block', () => {
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', good)))).toEqual([]);
  });

  it('flags a missing required section', () => {
    const body = good.replace(/### Connections[\s\S]*?### Flow/, '### Flow');
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', body))).join()).toMatch(/missing required section: Connections/);
  });

  it('flags sections out of order', () => {
    const body = ['### Connections', '- in: x', '', '### Purpose', 'P.', '', '### Flow', '```mermaid', 'flowchart TD', '  A --> B', '```'].join('\n');
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', body))).join()).toMatch(/out of order/);
  });

  it('flags a fence after the mermaid fence', () => {
    const body = `${good}\n~~~\ntrailing\n~~~`;
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', body))).join()).toMatch(/fence after the mermaid fence/);
  });

  it('flags a missing mermaid fence', () => {
    const body = ['### Purpose', 'P.', '', '### Connections', '- in: x', '', '### Flow', 'see the code'].join('\n');
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', body))).join()).toMatch(/missing mermaid fence/);
  });

  it('flags a -00 block owned by another file', () => {
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:CLI-00', good))).join()).toMatch(/belongs in docs\/arch\/cli\.md/);
  });

  it('flags an unknown prefix', () => {
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ZZ-00', good))).join()).toMatch(/unknown prefix/);
  });

  it('flags more than one -00 block per file', () => {
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-00', good), block('arch:ABI-00', good))).join()).toMatch(/more than one -00/);
  });

  it('passes a file with no -00 block', () => {
    expect(lintDoc(doc('docs/arch/ABI.md', block('arch:ABI-01', 'one statement')))).toEqual([]);
  });
});

describe('covers', () => {
  const at = (path, ...blocks) => doc(path, ...blocks);

  it('accepts a glob that matches and a path#symbol that exists', () => {
    const d = at('docs/arch/a.md', block('arch:A-01', 'covers: scripts/docsKeys.mjs, src/**/entityId.ts'));
    expect(lintCovers([d])).toEqual([]);
  });

  it('flags a glob that matches nothing', () => {
    const d = at('docs/arch/a.md', block('arch:A-01', 'covers: no/such/**/*.ts'));
    expect(lintCovers([d]).join()).toMatch(/glob matches no files/);
  });

  it('flags a missing file', () => {
    const d = at('docs/arch/a.md', block('arch:A-01', 'covers: scripts/nope.ts#x'));
    expect(lintCovers([d]).join()).toMatch(/file not found/);
  });

  it('flags a symbol that does not exist', () => {
    const d = at('docs/arch/a.md', block('arch:A-01', 'covers: scripts/docsKeys.mjs#nopeSymbol'));
    expect(lintCovers([d]).join()).toMatch(/symbol not found/);
  });

  it('accepts a path#symbol that exists', () => {
    const d = at('docs/arch/a.md', block('arch:A-01', 'covers: scripts/docsKeys.mjs#symbolRange'));
    expect(lintCovers([d])).toEqual([]);
  });

  it('builds an inverted map with sorted keys and values', () => {
    const docs = [
      at('docs/arch/b.md', block('arch:B-01', 'covers: z.ts, a.ts')),
      at('docs/arch/a.md', block('arch:A-01', 'covers: z.ts')),
    ];
    expect(buildCovers(docs)).toEqual({ 'a.ts': ['arch:B-01'], 'z.ts': ['arch:A-01', 'arch:B-01'] });
  });

  it('detects a stale COVERS.json but accepts a fresh one', () => {
    const docs = [at('docs/arch/a.md', block('arch:A-01', 'covers: a.ts'))];
    expect(coversStale(docs, coversJson(docs))).toBe(false);
    expect(coversStale(docs, '{}\n')).toBe(true);
  });
});

describe('symbolRange', () => {
  it('finds a function and the line of its closing brace', () => {
    const text = ['export function foo() {', '  return 1;', '}', 'const after = 1;'].join('\n');
    expect(symbolRange(text, 'foo')).toEqual({ start: 1, end: 3 });
  });

  it('finds a const object literal', () => {
    expect(symbolRange(['const BAR = {', '  a: 1,', '};'].join('\n'), 'BAR')).toEqual({ start: 1, end: 3 });
  });

  it('finds a class method', () => {
    const text = ['class X {', '  bar() {', '    return 1;', '  }', '}'].join('\n');
    expect(symbolRange(text, 'bar')).toEqual({ start: 2, end: 4 });
  });

  it('ignores braces inside strings and comments', () => {
    const text = ['function f() {', "  const s = '}';", '  // }', '}'].join('\n');
    expect(symbolRange(text, 'f')).toEqual({ start: 1, end: 4 });
  });

  it('returns the start line when there is no brace', () => {
    expect(symbolRange('type X = A | B;', 'X')).toEqual({ start: 1, end: 1 });
  });

  it('returns null for an unknown symbol', () => {
    expect(symbolRange('const x = 1;', 'y')).toBeNull();
  });
});
