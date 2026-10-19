// Generate the architectural import map in docs/arch/system-map.md.
// CLI: node scripts/archGraph.mjs [--check]
//
// dependency-cruiser is the source of truth for the import graph: this script
// runs it with tsPreCompilationDeps so `import type` edges are visible, then
// collapses src/<top-level-entry>/... to the layer table in arch-layers.json.
// Value edges become the MAP-01 flowchart; type-only edges become the MAP-02
// table. Both regions are replaced in place, so the surrounding prose is hand
// written.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const LAYERS_PATH = join(ROOT, 'scripts/arch-layers.json');
const DEPCRUISE = join(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = join(ROOT, '.dependency-cruiser.cjs');
export const SYSTEM_MAP = join(ROOT, 'docs/arch/system-map.md');

const TEST_FILE = /\.(?:integration\.test|e2e\.test|test)\.tsx?$/;
const FIXTURE_DIR = /(?:^|\/)fixtures(?:\/|$)/;
const GENERATED_START = /^<!-- GENERATED:start id=([A-Za-z0-9_-]+)(?: .*)? -->$/;
const GENERATED_END = /^<!-- GENERATED:end id=([A-Za-z0-9_-]+) -->$/;

/** The immediate children of `src`: directories and non-test root files. */
export function srcEntries(root = SRC) {
  const dirs = [];
  const files = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (/\.tsx?$/.test(e.name) && !TEST_FILE.test(e.name)) files.push(e.name);
  }
  return { dirs: dirs.sort(), files: files.sort() };
}

/**
 * Validate the layer table: every top-level `src` entry is assigned exactly
 * once, every member exists, and no layer reuses a directory name (which would
 * make a rule read as if it named a directory instead of a layer).
 */
export function validateLayers(layers, { dirs, files }) {
  const errors = [];
  const entries = new Set([...dirs, ...files]);
  const dirNames = new Set(dirs);
  const assigned = new Map();
  for (const [layer, members] of Object.entries(layers)) {
    if (dirNames.has(layer)) errors.push(`layer "${layer}" has the same name as a src directory`);
    if (!Array.isArray(members) || members.length === 0) errors.push(`layer "${layer}" has no entries`);
    for (const member of members ?? []) {
      if (!entries.has(member)) errors.push(`layer "${layer}" names unknown src entry "${member}"`);
      else if (assigned.has(member)) {
        errors.push(`src entry "${member}" is assigned to both "${assigned.get(member)}" and "${layer}"`);
      } else assigned.set(member, layer);
    }
  }
  for (const entry of [...entries].sort()) {
    if (!assigned.has(entry)) errors.push(`src entry "${entry}" is not assigned to any layer`);
  }
  return errors;
}

export function loadLayers(path = LAYERS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `src/extension.ts` -> `extension.ts`; deeper paths collapse to their top entry. */
export function topEntry(source) {
  const rel = source.split(sep).join('/').replace(/^\.?\/?/, '');
  if (!rel.startsWith('src/')) return null;
  return rel.slice('src/'.length).split('/')[0];
}

/** A valid mermaid id for a top-level entry (`extension.ts` -> `extension_ts`). */
export function nodeId(entry) {
  return entry.replace(/[^A-Za-z0-9_]/g, '_');
}

/** `{ layerByName, entryLayer }` lookups for the configured table. */
function layerIndex(layers) {
  const entryLayer = new Map();
  for (const [layer, members] of Object.entries(layers)) {
    for (const member of members) entryLayer.set(member, layer);
  }
  return { entryLayer };
}

function skipped(source) {
  return TEST_FILE.test(source) || FIXTURE_DIR.test(source);
}

/**
 * Collapse a dependency-cruiser JSON report to top-level-entry edges, split by
 * `type-only`. Intra-entry edges are omitted: the diagram is about layers, and
 * a file importing its sibling is not a layer edge.
 */
export function collapseEdges(report, layers) {
  const { entryLayer } = layerIndex(layers);
  const value = new Set();
  const type = new Map();
  for (const mod of report.modules ?? []) {
    const from = topEntry(mod.source);
    if (!from || skipped(mod.source) || !entryLayer.has(from)) continue;
    for (const dep of mod.dependencies ?? []) {
      const to = topEntry(dep.resolved ?? '');
      if (!to || to === from || skipped(dep.resolved) || !entryLayer.has(to)) continue;
      const key = `${from}\0${to}`;
      if (dep.dependencyTypes?.includes('type-only')) {
        if (!type.has(key)) type.set(key, new Set());
        type.get(key).add(mod.source.split(sep).join('/'));
      } else {
        value.add(key);
      }
    }
  }
  const split = (key) => key.split('\0');
  return {
    value: [...value].map(split).sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
    type: [...type.entries()]
      .map(([key, sources]) => [...split(key), sources.size])
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  };
}

/** The MAP-01 flowchart: one subgraph per layer, value edges only, sorted. */
export function renderMap01(layers, edges) {
  const lines = ['flowchart LR'];
  for (const layer of Object.keys(layers).sort()) {
    lines.push(`  subgraph ${layer}`);
    for (const entry of [...layers[layer]].sort()) {
      lines.push(`    ${nodeId(entry)}["${entry}"]`);
    }
    lines.push('  end');
  }
  const sorted = [...edges.value].sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  for (const [from, to] of sorted) lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
  return lines.join('\n');
}

/** The MAP-02 table: type-only from|to|files, where files is a distinct count. */
export function renderMap02(edges) {
  const lines = ['| from | to | files |', '|---|---|---:|'];
  const sorted = [...edges.type].sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  for (const [from, to, files] of sorted) lines.push(`| ${from} | ${to} | ${files} |`);
  return lines.join('\n');
}

/**
 * Replace the body between `<!-- GENERATED:start id=ID ... -->` and
 * `<!-- GENERATED:end id=ID -->`. Both markers must appear exactly once; the
 * text outside them is returned untouched.
 */
export function replaceRegion(text, id, body) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (GENERATED_START.exec(line)?.[1] === id ? [i] : []));
  const ends = lines.flatMap((line, i) => (GENERATED_END.exec(line)?.[1] === id ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(`generated region ${id} needs exactly one start and end marker`);
  }
  return [...lines.slice(0, starts[0] + 1), body, ...lines.slice(ends[0])].join('\n');
}

/** Run dependency-cruiser and return its JSON report. */
export function runDepcruise({ cwd = ROOT } = {}) {
  const out = execFileSync(process.execPath, [DEPCRUISE, 'src', '--config', CONFIG, '--output-type', 'json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/** The two generated region bodies, from a report. */
export function renderRegions(report, layers) {
  const edges = collapseEdges(report, layers);
  return { 'MAP-01': renderMap01(layers, edges), 'MAP-02': renderMap02(edges) };
}

function main(args) {
  const { dirs, files } = srcEntries();
  const layers = loadLayers();
  const errors = validateLayers(layers, { dirs, files });
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  const regions = renderRegions(runDepcruise(), layers);
  const current = readFileSync(SYSTEM_MAP, 'utf8');
  let next = current;
  for (const [id, body] of Object.entries(regions)) next = replaceRegion(next, id, body);
  if (args.includes('--check')) {
    if (next !== current) {
      console.error('docs/arch/system-map.md is stale: run npm run -s docs:graph');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(SYSTEM_MAP, next);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
