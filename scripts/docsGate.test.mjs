import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { globToRegExp, parseDiff, run } from './docsGate.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'docsGate.mjs');
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

const SRC = `export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}
`;
const DOC = `# Doc

## [@arch:T-01] Rule
covers: src/a.ts#alpha, src/*.ts
text
END_DOC_BLOCK: [@arch:T-01]

## [@arch:T-02] Other
other
END_DOC_BLOCK: [@arch:T-02]
`;

function repo(covers) {
  const cwd = mkdtempSync(join(tmpdir(), 'docs-gate-'));
  dirs.push(cwd);
  const g = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const put = (p, t) => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), t); };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.invalid');
  g('config', 'user.name', 't');
  put('src/a.ts', SRC);
  put('src/extension.ts', SRC);
  put('docs/arch/t.md', DOC);
  put('docs/COVERS.json', JSON.stringify(covers));
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'feat');
  return { cwd, put, commit: () => { g('add', '-A'); g('commit', '-q', '-m', 'change'); }, run: (body = '') => run({ baseRef: 'main', body, cwd }) };
}

const COVERS = { 'src/a.ts#alpha': ['arch:T-01'], 'src/*.ts': ['arch:T-01'] };

describe('docsGate', () => {
  it('blocks an uncited symbol edit', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.commit();
    const out = r.run();
    expect(out.block).toBe(true);
    expect(out.lines.join('\n')).toContain('✗ BLOCK diff changes alpha in src/a.ts (covered by @arch:T-01, block at docs/arch/t.md:3)');
  });

  it('BLOCK message names symbol, block location and the commit rule', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.commit();
    const msg = r.run().lines.join('\n');
    expect(msg).toContain('alpha in src/a.ts');
    expect(msg).toContain('@arch:T-01, block at docs/arch/t.md:3');
    expect(msg).toContain('reads committed changes — commit the block edit, then rerun: BASE_REF=main PR_BODY= node scripts/docsGate.mjs');
  });

  it('passes when the key is cited in the PR body', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.commit();
    expect(r.run('touches @arch:T-01 as documented').block).toBe(false);
    expect(r.run('@arch:T-010').block).toBe(true);
  });

  it('passes when the covering block is edited', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.put('docs/arch/t.md', DOC.replace('\ntext\n', '\nnew text\n'));
    r.commit();
    expect(r.run().block).toBe(false);
  });

  it('does not pass on an edit to a different block', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.put('docs/arch/t.md', DOC.replace('\nother\n', '\nchanged\n'));
    r.commit();
    expect(r.run().block).toBe(true);
  });

  it('only warns for a glob-only change', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 2', 'return 20'));
    r.commit();
    const out = r.run();
    expect(out.block).toBe(false);
    expect(out.lines.join('\n')).toContain('⚠ WARN src/a.ts');
  });

  it('skips hub files', () => {
    const r = repo({ 'src/extension.ts#alpha': ['arch:T-01'], 'src/*.ts': ['arch:T-01'] });
    r.put('src/extension.ts', SRC.replace('return 1', 'return 10'));
    r.commit();
    const out = r.run();
    expect(out.block).toBe(false);
    expect(out.lines).toEqual(['· skip src/extension.ts (hub exclude)']);
  });

  it('still gates a symbol renamed in head but present in base', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('function alpha', 'function alphaRenamed'));
    r.commit();
    const out = r.run();
    expect(out.block).toBe(true);
    expect(out.lines.join('\n')).toContain('BLOCK diff changes alpha');
  });

  it('errors when the symbol is missing on both sides', () => {
    const r = repo({ 'src/a.ts#ghost': ['arch:T-01'] });
    r.put('src/a.ts', SRC.replace('return 2', 'return 20'));
    r.commit();
    const out = r.run();
    expect(out.block).toBe(true);
    expect(out.lines.join('\n')).toContain('covers stale');
  });

  it('treats a PR body with $(...) as text', () => {
    const r = repo(COVERS);
    r.put('src/a.ts', SRC.replace('return 1', 'return 10'));
    r.commit();
    const marker = join(r.cwd, 'pwned');
    const body = `$(touch ${marker}) \`touch ${marker}\` @arch:T-01`;
    const res = spawnSync('node', [SCRIPT], { cwd: r.cwd, encoding: 'utf8', env: { ...process.env, BASE_REF: 'main', PR_BODY: body } });
    expect(res.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('helpers', () => {
  it('parses -U0 hunks on both sides', () => {
    const d = parseDiff('--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3 @@\n-a\n-b\n+c\n@@ -9,0 +9,2 @@\n+d\n+e\n');
    expect(d.get('x.ts')).toEqual({ base: [[3, 4]], head: [[3, 3], [9, 10]] });
  });

  it('globs', () => {
    expect(globToRegExp('src/**/index.ts').test('src/index.ts')).toBe(true);
    expect(globToRegExp('src/**/index.ts').test('src/a/b/index.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('a.{ts,tsx}').test('a.tsx')).toBe(true);
  });
});
