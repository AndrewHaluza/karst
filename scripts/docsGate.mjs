// PR docs-gate (arch:DOC-03): a diff that changes a symbol covered by an @arch block must cite or edit it.
// Env: BASE_REF (PR base branch; defaults to `develop` for the local `npm run docs:gate`), PR_BODY (PR description; read as text, never evaluated). Dependency-free.
// Reads COMMITTED changes only (BASE_REF...HEAD): an uncommitted block edit still BLOCKs.
// CLI: node scripts/docsGate.mjs      Exit 1 on any BLOCK or stale covers entry.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { symbolRange } from './docsKeys.mjs';

export const HUB_EXCLUDE = ['src/extension.ts', 'src/**/index.ts'];

const OPEN = /^## \[@([^\]]+)\] /;
const END = /^END_DOC_BLOCK: \[@([^\]]+)\]\s*$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp over repo-relative `/` paths. */
export function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth++; re += '(?:'; }
    else if (c === '}' && depth > 0) { depth--; re += ')'; }
    else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const isGlob = (s) => /[*?{]/.test(s);
const matches = (glob, file) => globToRegExp(glob).test(file);

/** `git diff -U0` text -> `Map<file, { base: [s,e][], head: [s,e][] }>` (1-based inclusive line ranges). */
export function parseDiff(text) {
  const files = new Map();
  let cur = null;
  let oldPath = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('--- ')) oldPath = line.slice(4).replace(/^a\//, '');
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      const path = p === '/dev/null' ? oldPath : p;
      cur = { base: [], head: [] };
      files.set(path, cur);
    } else if (cur) {
      const m = HUNK.exec(line);
      if (!m) continue;
      const [, a, b = '1', c, d = '1'] = m;
      if (+b > 0) cur.base.push([+a, +a + +b - 1]);
      if (+d > 0) cur.head.push([+c, +c + +d - 1]);
    }
  }
  return files;
}

const overlaps = (ranges, r) => !!r && ranges.some(([s, e]) => s <= r.end && e >= r.start);

/** Line ranges `{ key, start, end }` of every keyed block in a markdown text. */
export function blockRanges(text) {
  const out = [];
  let open = null;
  text.split('\n').forEach((line, i) => {
    const o = OPEN.exec(line);
    if (o) open = { key: o[1], start: i + 1 };
    const e = END.exec(line);
    if (e && open && open.key === e[1]) { out.push({ ...open, end: i + 1 }); open = null; }
  });
  return out;
}

const cites = (body, key) =>
  new RegExp(`@${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(body);

/**
 * Pure core. `diff`: parseDiff result; `covers`: COVERS.json object;
 * `readBase`/`readHead`: path -> text | null. Returns `{ lines, block }`.
 */
export function evaluate({ diff, covers, body, readBase, readHead, hub = HUB_EXCLUDE, baseRef = 'develop', locate = () => null }) {
  const lines = [];
  let failed = false;

  const edited = new Set();
  for (const [file, h] of diff) {
    if (!file.endsWith('.md')) continue;
    for (const [ranges, read] of [[h.base, readBase], [h.head, readHead]]) {
      const text = read(file);
      if (text == null) continue;
      for (const b of blockRanges(text)) if (overlaps(ranges, b)) edited.add(b.key);
    }
  }
  const passed = (keys) => keys.some((k) => cites(body, k) || edited.has(k));

  const skipped = new Set();
  const warned = new Set();
  const symbolItems = Object.entries(covers).filter(([item]) => item.includes('#'));
  const globItems = Object.entries(covers).filter(([item]) => !item.includes('#') && isGlob(item));
  const plainItems = Object.entries(covers).filter(([item]) => !item.includes('#') && !isGlob(item));

  for (const [file, h] of diff) {
    const hubbed = hub.some((g) => matches(g, file));
    const fileSyms = symbolItems.filter(([item]) => item.slice(0, item.indexOf('#')) === file);
    const fileGlobs = [...globItems, ...plainItems].filter(([item]) => matches(item, file));
    if (hubbed) {
      if (fileSyms.length || fileGlobs.length) skipped.add(file);
      continue;
    }

    for (const [item, keys] of fileGlobs) {
      const w = `${item}\0${file}`;
      if (warned.has(w)) continue;
      warned.add(w);
      lines.push(`⚠ WARN ${file} changed (covered by ${keys.map((k) => `@${k}`).join(', ')} via ${item}). Check the block still holds.`);
    }

    if (!fileSyms.length) continue;
    const baseText = readBase(file);
    const headText = readHead(file);
    const ranges = fileSyms.map(([item, keys]) => {
      const symbol = item.slice(item.indexOf('#') + 1);
      return {
        item, keys, symbol,
        base: baseText == null ? null : symbolRange(baseText, symbol),
        head: headText == null ? null : symbolRange(headText, symbol),
      };
    });
    for (const r of ranges) {
      if (!r.base && !r.head) {
        failed = true;
        lines.push(`✗ ERROR covers stale: ${r.item} not found on base or head (@${r.keys.join(', @')}). Fix the covers: line.`);
      }
    }

    // A hunk passes when any covered symbol it touches has a cited/edited key.
    const hunks = [
      ...h.base.map((r) => ({ side: 'base', r })),
      ...h.head.map((r) => ({ side: 'head', r })),
    ];
    const blocked = new Map();
    for (const { side, r } of hunks) {
      const hit = ranges.filter((x) => overlaps([r], x[side]));
      if (!hit.length || passed(hit.flatMap((x) => x.keys))) continue;
      for (const x of hit) blocked.set(x.item, x);
    }
    for (const x of blocked.values()) {
      failed = true;
      const k = x.keys[0];
      const at = locate(k);
      lines.push(`✗ BLOCK diff changes ${x.symbol} in ${file} (covered by @${k}${at ? `, block at ${at}` : ''}). Cite @${k} in the PR body or edit the block. The gate reads committed changes — commit the block edit, then rerun: BASE_REF=${baseRef} PR_BODY= node scripts/docsGate.mjs`);
    }
  }
  for (const f of skipped) lines.push(`· skip ${f} (hub exclude)`);
  return { lines, block: failed };
}

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** `file:line` of the `## [@key]` heading under docs/, or null. */
export function locateBlock(cwd, key) {
  try {
    const out = git(['grep', '-n', '-F', `## [@${key}] `, '--', 'docs'], cwd).split('\n')[0] ?? '';
    const m = /^([^:]+):(\d+):/.exec(out);
    return m ? `${m[1]}:${m[2]}` : null;
  } catch { return null; }
}

/** `origin/<base>` when present, else the local branch (a sandbox worktree may have no remote ref). */
function resolveRef(baseRef, cwd) {
  try { git(['rev-parse', '--verify', '-q', `origin/${baseRef}^{commit}`], cwd); return `origin/${baseRef}`; } catch { return baseRef; }
}

/** Full run against a repo: diff `origin/<baseRef>...HEAD`, read covers, evaluate. */
export function run({ baseRef, body = '', cwd = process.cwd() }) {
  if (!baseRef || baseRef.startsWith('-')) throw new Error('BASE_REF is missing or invalid');
  const covers = JSON.parse(readFileSync(`${cwd}/docs/COVERS.json`, 'utf8'));
  const ref = resolveRef(baseRef, cwd);
  const diff = parseDiff(git(['diff', '-U0', '--no-color', '--no-renames', `${ref}...HEAD`], cwd));
  const mergeBase = git(['merge-base', ref, 'HEAD'], cwd).trim();
  const show = (rev) => (path) => {
    try { return git(['show', `${rev}:${path}`], cwd); } catch { return null; }
  };
  return evaluate({ diff, covers, body, readBase: show(mergeBase), readHead: show('HEAD'), baseRef, locate: (key) => locateBlock(cwd, key) });
}

function main() {
  const { lines, block } = run({ baseRef: process.env.BASE_REF || 'develop', body: process.env.PR_BODY ?? '' });
  const out = lines.length ? lines : ['✓ docs-gate: no covered symbol changed'];
  console.log(out.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### docs-gate\n\n${out.map((l) => `- ${l}`).join('\n')}\n`);
  }
  process.exitCode = block ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
