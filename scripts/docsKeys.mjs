// Lint and index the keyed-block reference docs (`## [@ns:ID] Title` ... `END_DOC_BLOCK: [@ns:ID]`).
// CLI: node scripts/docsKeys.mjs lint | index [--check] | covers [--check]
import { globSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BLOCK_BYTES = 6400; // 6200 -> 6400: the generated MAP-04 schema ER grew past 6200 with cloud_session_links (v90)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');
const SRC_DIR = join(ROOT, 'src');
const INDEX_PATH = join(ROOT, 'docs/INDEX.md');
const INDEX_REL = 'docs/INDEX.md';
const COVERS_PATH = join(ROOT, 'docs/COVERS.json');
const COVERS_REL = 'docs/COVERS.json';
const SKIP_DIRS = new Set(['plans', 'superpowers']);
const SKIP_FILES = new Set(['docs/extension-inventory.md', 'docs/issues/extension-inventory.md', INDEX_REL]);
const OPEN = /^## \[@([^\]]+)\] (.*)$/;
const END = /^END_DOC_BLOCK: \[@([^\]]+)\]\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADER = /^<!-- AGENT INSTRUCTIONS:[\s\S]*?-->/;
// Cross-references to a keyed block. Only the `arch` and `issue` namespaces are
// linted here; the other namespaces (`ui:`, `core:`, `gloss:`, `ts:`, …) are a
// separate concern. `KEY` is the docs' own metavariable for "any key" (see
// `docs/arch/cli.md`), so it is never a real reference.
const REF_NS = 'arch|issue';
const BARE_REF = new RegExp(`@(${REF_NS}):([A-Za-z0-9_-]+)`, 'g');
const QUALIFIED_REF = new RegExp(`([A-Za-z0-9_./-]+\\.md)#@(${REF_NS}):([A-Za-z0-9_-]+)`, 'g');
const PLACEHOLDER_IDS = new Set(['KEY']);

// The -00 overview block of every `docs/arch` file uses a fixed prefix, so a
// key like `ABI-00` can only live in ABI.md. Rule keys are not renamed (refs
// stay valid); only the overview block is pinned. `model-store-workflow-layering.md`
// was folded into `system-map.md` (MAP-03).
export const ARCH_PREFIXES = Object.freeze({
  'docs/arch/ABI.md': 'ABI',
  'docs/arch/approaches.md': 'APP',
  'docs/arch/agent-cores.md': 'AC',
  'docs/arch/cli.md': 'CLI',
  'docs/arch/debug-logging.md': 'DBG',
  'docs/arch/diagnostics.md': 'DIAG',
  'docs/arch/github-and-merge.md': 'GH',
  'docs/arch/ids.md': 'IDS',
  'docs/arch/manifest-and-settings.md': 'MS',
  'docs/arch/prompt-metrics.md': 'PM',
  'docs/arch/stages-and-gates.md': 'SG',
  'docs/arch/store-and-schema.md': 'ST',
  'docs/arch/worktrees-and-servers.md': 'WT',
  'docs/arch/uat-host.md': 'UATHOST',
  'docs/arch/adr-impl-exit-condition.md': 'ADR',
  'docs/arch/system-map.md': 'MAP',
});

// -00 overview blocks only. Rule blocks (one statement, no sections) are not
// section-linted, so the check can land before W3 rewrites each file.
const OVERVIEW_KEY = /^[A-Z]+-00$/;
const OVERVIEW_SECTIONS = ['Purpose', 'Connections', 'Flow'];
const OPTIONAL_SECTIONS = ['State', 'Tradeoffs', 'Fallbacks', 'Rules'];
const SECTION_ORDER = [...OVERVIEW_SECTIONS, ...OPTIONAL_SECTIONS];
const COVERS_LINE = /^covers:\s*(.+?)\s*$/;

/** The part of a keyed-block id after the namespace (`arch:ABI-00` -> `ABI-00`). */
function keyPart(id) {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

function parse(text) {
  const header = HEADER.exec(text)?.[0] ?? null;
  const body = header ? text.slice(header.length) : text;
  const blocks = [];
  const errors = [];
  let fence = null;
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const size = Buffer.byteLength(line) + 1;
    const f = FENCE.exec(line)?.[1];
    if (f && !fence) fence = f;
    else if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
    if (fence || f) {
      if (cur) {
        cur.bytes += size;
        cur.body.push(line);
      }
      continue;
    }
    const open = OPEN.exec(line);
    const end = END.exec(line);
    if (open) {
      if (cur) errors.push(`${cur.id}: no END before next block`);
      cur = { id: open[1], title: open[2], bytes: size, body: [] };
    } else if (end) {
      if (!cur) errors.push(`${end[1]}: END without open block`);
      else if (cur.id !== end[1]) errors.push(`${cur.id}: END mismatch (found ${end[1]})`);
      if (cur) blocks.push({ ...cur, bytes: cur.bytes + size });
      cur = null;
    } else {
      if (line.startsWith('## ')) errors.push(`unkeyed ## heading: ${line.slice(0, 60)}`);
      if (cur) {
        cur.bytes += size;
        cur.body.push(line);
      }
    }
  }
  if (cur) errors.push(`${cur.id}: no END marker`);
  return { header, blocks, errors };
}

/**
 * The `### ` section headings and the code fences of a block body, in order.
 * Fences carry their opening info string (`mermaid`, `md`, …) and body line
 * indices, so the overview lint can find the Flow diagram and reject a fence
 * after it. Headings inside a fence are ignored.
 */
function blockSections(body) {
  const sections = [];
  const fences = [];
  let fence = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const f = FENCE.exec(line)?.[1];
    if (f && !fence) {
      fence = f;
      fences.push({ info: line.trim().replace(/^[`~]+/, '').trim(), start: i, end: null });
      continue;
    }
    if (f && fence && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) {
      fence = null;
      fences[fences.length - 1].end = i;
      continue;
    }
    if (fence) continue;
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) sections.push({ name: m[1], line: i });
  }
  return { sections, fences };
}

/** The repo-relative `covers:` items of a block, or `null` when it has none. */
export function blockCovers(block) {
  const first = block.body?.[0];
  const m = first && COVERS_LINE.exec(first);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Lint the -00 overview block format: the prefix must match the file the
 * `ARCH_PREFIXES` table assigns, at most one -00 block per file, the required
 * `### ` sections must be present in order, and the Flow mermaid fence must be
 * the last fence in the block. Files with no -00 block are not checked.
 */
function lintOverview(path, blocks) {
  const out = [];
  const overviews = blocks.filter((b) => b.id.startsWith('arch:') && OVERVIEW_KEY.test(keyPart(b.id)));
  if (overviews.length > 1) out.push(`${path}: more than one -00 overview block`);
  for (const b of overviews) {
    const key = keyPart(b.id);
    const prefix = key.replace(/-00$/, '');
    const owner = Object.keys(ARCH_PREFIXES).find((f) => ARCH_PREFIXES[f] === prefix);
    if (!owner) out.push(`${path}: ${key} has an unknown prefix (not in the prefix table)`);
    else if (owner !== path) out.push(`${path}: ${key} belongs in ${owner}`);

    const { sections, fences } = blockSections(b.body ?? []);
    const names = sections.map((s) => s.name);
    for (const req of OVERVIEW_SECTIONS) {
      if (!names.includes(req)) out.push(`${path}: ${b.id} missing required section: ${req}`);
    }
    const present = names.filter((n) => SECTION_ORDER.includes(n));
    const sorted = [...present].sort((a, c) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(c));
    if (present.join('|') !== sorted.join('|')) out.push(`${path}: ${b.id} sections out of order`);
    const mermaid = fences.findIndex((f) => f.info === 'mermaid');
    if (mermaid < 0) out.push(`${path}: ${b.id} missing mermaid fence`);
    else if (mermaid !== fences.length - 1) out.push(`${path}: ${b.id} has a fence after the mermaid fence`);
  }
  return out;
}

export function lintDoc({ path, text }) {
  const { header, blocks, errors } = parse(text);
  const out = errors.map((e) => `${path}: ${e}`);
  if (!header) return [`${path}: missing AGENT INSTRUCTIONS header`, ...out];
  if (header.includes('<file_path>')) out.push(`${path}: header has <file_path> placeholder`);
  const cmdLines = header.split(/\r?\n/).filter((l) => /^\s+(grep|awk)\b/.test(l));
  for (const p of new Set(cmdLines.flatMap((l) => l.match(/[\w./-]+\.md\b/g) ?? []))) {
    if (p !== path) out.push(`${path}: header path ${p} does not match this file`);
  }
  const seen = new Set();
  for (const b of blocks) {
    if (seen.has(b.id)) out.push(`${path}: duplicate id ${b.id}`);
    seen.add(b.id);
    if (b.bytes > MAX_BLOCK_BYTES) out.push(`${path}: ${b.id} exceeds ${MAX_BLOCK_BYTES} B (${b.bytes})`);
  }
  out.push(...lintOverview(path, blocks));
  return out;
}

/**
 * Lint every `covers:` line: a glob must match at least one repo file, and a
 * `path#symbol` must name an existing file that declares the symbol. `root`
 * is injectable so tests can point at a temp tree.
 */
export function lintCovers(docs, { root = ROOT, glob = globSync } = {}) {
  const out = [];
  for (const d of docs) {
    for (const b of parse(d.text).blocks) {
      const items = blockCovers(b);
      if (!items) continue;
      for (const item of items) {
        const hash = item.indexOf('#');
        if (hash >= 0) {
          const file = item.slice(0, hash);
          const symbol = item.slice(hash + 1);
          let text;
          try {
            text = readFileSync(join(root, file), 'utf8');
          } catch {
            out.push(`${d.path}: ${b.id}: covers ${item} — file not found`);
            continue;
          }
          if (!symbolRange(text, symbol)) out.push(`${d.path}: ${b.id}: covers ${item} — symbol not found`);
        } else if (glob(item, { cwd: root }).length === 0) {
          out.push(`${d.path}: ${b.id}: covers ${item} — glob matches no files`);
        }
      }
    }
  }
  return out;
}

/**
 * The `covers:` items of every block, inverted to `{ item: [key, …] }` with
 * sorted keys and values. Written to `docs/COVERS.json` by `covers`, consumed
 * by the W4 PR gate to map a changed file to the docs that claim to cover it.
 */
export function buildCovers(docs) {
  const map = new Map();
  for (const d of docs) {
    for (const b of parse(d.text).blocks) {
      const items = blockCovers(b);
      if (!items) continue;
      for (const item of items) {
        if (!map.has(item)) map.set(item, new Set());
        map.get(item).add(b.id);
      }
    }
  }
  const out = {};
  for (const k of [...map.keys()].sort()) out[k] = [...map.get(k)].sort();
  return out;
}

/** Stable 2-space JSON for `docs/COVERS.json`, with a trailing newline. */
export function coversJson(docs) {
  return `${JSON.stringify(buildCovers(docs), null, 2)}\n`;
}

/** True when `current` (the on-disk `docs/COVERS.json`) is stale. */
export function coversStale(docs, current) {
  return current !== coversJson(docs);
}

export function buildIndex(docs) {
  const lines = [];
  for (const d of [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    for (const b of parse(d.text).blocks) lines.push(`[@${b.id}] ${d.path} — ${b.title}`);
  }
  return [
    '# Docs key index (generated)',
    '',
    'Generated by `npm run -s docs:index`. Do not edit. Search it, never read it whole:',
    '`grep -i <topic> docs/INDEX.md`, then extract the block with the awk recipe in the file header.',
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Every keyed block in the collected docs, mapped to the docs that define it.
 * Keys are not globally unique (e.g. `arch:CONTENTS` is defined in several
 * files), so a bare reference to a key with more than one defining doc is
 * ambiguous and must use the qualified form.
 */
export function keyIndex(docs) {
  const index = new Map();
  for (const d of docs) {
    for (const b of parse(d.text).blocks) {
      const files = index.get(b.id);
      if (files) files.add(d.path);
      else index.set(b.id, new Set([d.path]));
    }
  }
  return index;
}

/**
 * Lint `@arch:`/`@issue:` cross-references in `sources` against `index`. A bare
 * reference must resolve to exactly one defining doc; `path#@ns:KEY` must
 * resolve to the doc it names (a leading `./` is accepted). A block's definition
 * marker and the per-file AGENT INSTRUCTIONS header are not references, though a
 * reference in a block heading's title still is. `KEY` is the docs' own
 * metavariable for "any key" and is skipped.
 */
export function lintRefs(sources, index) {
  const out = [];
  for (const s of sources) {
    const lines = s.text.split(/\r?\n/);
    let fence = null;
    let inHeader = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inHeader) {
        if (line.includes('-->')) inHeader = false;
        continue;
      }
      if (line.startsWith('<!-- AGENT INSTRUCTIONS')) {
        if (!line.includes('-->')) inHeader = true;
        continue;
      }
      const f = FENCE.exec(line)?.[1];
      if (f && !fence) { fence = f; continue; }
      if (fence) {
        if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
        continue;
      }
      // A block definition is not a reference — but a reference may sit in its
      // heading title, so mask only the definition marker and keep the offset.
      let scan = line;
      const open = OPEN.exec(line);
      if (open) scan = ' '.repeat(line.length - open[2].length) + open[2];
      if (END.test(line)) scan = ' '.repeat(line.length);
      const qualified = [...scan.matchAll(QUALIFIED_REF)];
      for (const m of qualified) {
        const [, path, ns, id] = m;
        if (PLACEHOLDER_IDS.has(id)) continue;
        if (!index.get(`${ns}:${id}`)?.has(path.replace(/^\.\//, ''))) {
          out.push(`${s.path}:${i + 1}: unresolved reference ${path}#@${ns}:${id}`);
        }
      }
      const spans = qualified.map((m) => [m.index, m.index + m[0].length]);
      for (const m of scan.matchAll(BARE_REF)) {
        if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const [, ns, id] = m;
        if (PLACEHOLDER_IDS.has(id)) continue;
        const files = index.get(`${ns}:${id}`);
        if (!files) out.push(`${s.path}:${i + 1}: unresolved reference @${ns}:${id}`);
        else if (files.size > 1) {
          out.push(`${s.path}:${i + 1}: ambiguous reference @${ns}:${id} (defined in ${files.size} files: ${[...files].sort().join(', ')})`);
        }
      }
    }
  }
  return out;
}

export function collectDocs(dir = DOCS_DIR, skipDirs = SKIP_DIRS) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name)) files.push(...collectDocs(p, skipDirs));
    } else if (e.name.endsWith('.md')) {
      const rel = relative(ROOT, p).split(sep).join('/');
      if (!SKIP_FILES.has(rel)) files.push({ path: rel, text: readFileSync(p, 'utf8') });
    }
  }
  return files;
}

/**
 * The TypeScript sources a `@arch:`/`@issue:` reference may live in. Test files
 * are excluded: their fixtures assert the runtime's handling of keys that are
 * deliberately unknown, which are not doc references to resolve.
 */
function collectSrc(dir = SRC_DIR) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...collectSrc(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) {
      const rel = relative(ROOT, p).split(sep).join('/');
      files.push({ path: rel, text: readFileSync(p, 'utf8') });
    }
  }
  return files;
}

/**
 * Everything the reference lint reads: every doc under `docs/` plus `src/`.
 * This deliberately covers `plans/` and `superpowers/`, which the FORMAT lint
 * and the index skip — working notes do not follow the keyed-block format, but
 * a reference written in one still has to resolve.
 */
export function collectRefSources() {
  return [...collectDocs(DOCS_DIR, new Set()), ...collectSrc()];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SYMBOL_DECL = (n) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class|interface|type|enum)\\s+${n}\\b`, 'm');
const SYMBOL_METHOD = (n) => new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|readonly|async|abstract)\\s+)*${n}\\s*\\(`, 'm');

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** End index of the brace opened at `from`, or `-1`. Naive: skips strings and
 * comments but treats `${…}` inside a template literal as plain text. */
function braceEnd(text, from) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * The 1-based start/end lines of the declaration of `name` in TypeScript-like
 * `text`, or `null`. Start is the declaration line; end is the line of the brace
 * that closes the first `{` on or after the declaration. A declaration with no
 * brace (`type X = A | B;`) ends on its start line. Reused by the W4 PR gate.
 */
export function symbolRange(text, name) {
  const n = escapeRe(name);
  const m = SYMBOL_DECL(n).exec(text) ?? SYMBOL_METHOD(n).exec(text);
  if (!m) return null;
  const start = lineAt(text, m.index);
  const brace = text.indexOf('{', m.index);
  if (brace < 0) return { start, end: start };
  const end = braceEnd(text, brace);
  return { start, end: end < 0 ? start : lineAt(text, end) };
}

function main(cmd, flags) {
  const docs = collectDocs();
  if (cmd === 'lint') {
    const errs = [...docs.flatMap(lintDoc), ...lintCovers(docs), ...lintRefs(collectRefSources(), keyIndex(docs))];
    if (errs.length) console.error(errs.join('\n'));
    process.exitCode = errs.length ? 1 : 0;
  } else if (cmd === 'index') {
    const next = buildIndex(docs);
    if (flags.includes('--check')) {
      let cur = '';
      try { cur = readFileSync(INDEX_PATH, 'utf8'); } catch { /* missing counts as stale */ }
      if (cur !== next) { console.error(`${INDEX_REL} is stale: run npm run -s docs:index`); process.exitCode = 1; }
    } else writeFileSync(INDEX_PATH, next);
  } else if (cmd === 'covers') {
    const next = coversJson(docs);
    if (flags.includes('--check')) {
      let cur = '';
      try { cur = readFileSync(COVERS_PATH, 'utf8'); } catch { /* missing counts as stale */ }
      if (cur !== next) { console.error(`${COVERS_REL} is stale: run npm run -s docs:covers`); process.exitCode = 1; }
    } else writeFileSync(COVERS_PATH, next);
  } else {
    console.error('usage: docsKeys.mjs lint | index [--check] | covers [--check]');
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2], process.argv.slice(3));
