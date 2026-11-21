// Pure helpers of the `gate:mutation` review gate (@arch:GATE-MUTATION): the added line ranges of a
// ticket diff, the Stryker `--mutate` specs, and the verdict on the mutants that sit on those lines.
// No effect here: scripts/mutationChanged.mjs `--lines` does the git and Stryker work.

/** Unchanged lines that still join two hunks of one file, so a multi-line node edited twice is one range. */
export const JOIN_GAP = 3;
/** Most Stryker workers the gate starts. */
export const MAX_CONCURRENCY = 4;
/** A mutant with one of these statuses does not fail the ticket. */
export const PASS_STATUSES = new Set(['Killed', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored']);
/** A mutant that nothing detected on an added line fails the ticket. */
export const UNDETECTED_STATUSES = new Set(['Survived', 'NoCoverage']);

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The added line ranges per new path from ONE `git diff -U0 -M` text.
 * A delete-only hunk and a deleted file give no range. A rename is keyed by its new path.
 */
export function parseDiffRanges(diff) {
  const out = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\t.*$/, '');
      file = path.startsWith('b/') ? path.slice(2) : null;
      continue;
    }
    const hunk = file === null ? null : HUNK.exec(line);
    if (hunk === null) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const start = Number(hunk[1]);
    out.set(file, [...(out.get(file) ?? []), [start, start + count - 1]]);
  }
  return out;
}

/** Sort the ranges and join those that overlap or have at most `gap` unchanged lines between them. */
export function joinNearRanges(ranges, gap = JOIN_GAP) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start - last[1] - 1 <= gap) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** The `--mutate` specs: `file:a-b` per range, a bare path for a whole file (ranges null). */
export function mutateSpecs(rangesByFile) {
  return [...rangesByFile.keys()].sort().flatMap((path) => {
    const ranges = rangesByFile.get(path);
    return ranges === null ? [path] : ranges.map(([a, b]) => `${path}:${a}-${b}`);
  });
}

const onAddedLine = (ranges, line) => ranges === null || ranges.some(([a, b]) => line >= a && line <= b);

/**
 * Judge a Stryker JSON report. Only the mutants that start on an added line count.
 * Returns { failures, ignored: { static, disabled }, judged }.
 */
export function verdictOnAddedLines(report, rangesByFile) {
  const failures = [];
  const ignored = { static: 0, disabled: 0 };
  let judged = 0;
  for (const [file, data] of Object.entries(report.files ?? {})) {
    if (!rangesByFile.has(file)) continue;
    const ranges = rangesByFile.get(file);
    for (const m of data.mutants ?? []) {
      const line = m.location.start.line;
      if (!onAddedLine(ranges, line)) continue;
      judged += 1;
      if (m.status === 'Ignored') ignored[/static/i.test(m.statusReason ?? '') ? 'static' : 'disabled'] += 1;
      if (PASS_STATUSES.has(m.status)) continue;
      failures.push({ file, line, mutator: m.mutatorName, replacement: m.replacement ?? '', status: m.status });
    }
  }
  return { failures, ignored, judged };
}

/** The verdict as markdown: a summary line, the ignored split, and a table of the failures. */
export function linesMarkdown({ failures, ignored, judged }) {
  const lines = ['## Mutation (added lines)', ''];
  lines.push(failures.length === 0 ? `${judged} mutants on added lines, none undetected.` : `${judged} mutants on added lines, ${failures.length} undetected.`);
  lines.push(`Ignored on added lines: ${ignored.static + ignored.disabled} (${ignored.static} static, ${ignored.disabled} Stryker disable).`);
  if (failures.length > 0) {
    lines.push('', '| Location | Mutator | Replacement | Status |', '| --- | --- | --- | --- |');
    for (const f of failures) lines.push(`| ${f.file}:${f.line} | ${f.mutator} | \`${f.replacement.replace(/\s+/g, ' ').replace(/\|/g, '\\|')}\` | ${f.status} |`);
  }
  return lines.join('\n');
}

/** Stryker workers: half the cores, 1 to 4; `KARST_GATE_MAX_WORKERS=1` (a resource-kill retry) gives 1. */
export function concurrencyFor(cpus, env = process.env) {
  if (env.KARST_GATE_MAX_WORKERS === '1') return 1;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(cpus / 2)));
}
