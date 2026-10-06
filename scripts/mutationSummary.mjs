#!/usr/bin/env node
/**
 * CI mini report for the blocking mutation job (.github/workflows/ci.yml).
 *
 * `npm run test:mutation` breaks under `thresholds.break` (85), so a PR that
 * drops the score only ever showed the Stryker step as "Process completed with
 * exit code 1" — no clue WHERE the surviving mutants were. Now that the JSON
 * reporter is enabled (`reports/mutation/mutation.json`), this script turns
 * that report into what GitHub can actually show:
 *
 *   1. a run-summary Markdown block — overall score against the break
 *      threshold, a worst-first table of the files below it, and the top
 *      surviving / no-coverage mutants in each; and
 *   2. `::warning` annotations, but only for mutants in files the PR touched,
 *      so the "Files changed" tab marks the lines (GitHub caps annotations per
 *      step and only inlines lines that are part of the diff).
 *
 * The Stryker step owns pass/fail; this script must never change the verdict,
 * so a missing or malformed report is a message, never a crash.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REPORT = 'reports/mutation/mutation.json';
export const DEFAULT_CONFIG = 'stryker.config.json';
export const MAX_MUTANTS_PER_FILE = 5;
export const MAX_ANNOTATIONS = 10;

const UNDETECTED = new Set(['Survived', 'NoCoverage']);

function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\.\//, '');
}

function fmt(value) {
  return Number(value).toFixed(2);
}

/** Workflow-command escaping: `%`, CR and LF are unsafe in data and properties. */
function escapeData(value) {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/** Property values additionally treat `:` and `,` as separators. */
function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Collapse a snippet to one short line — sources and replacements can be multiline. */
function oneLine(value, max = 80) {
  const collapsed = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Inline-code-safe text: a backtick inside `code` would break the span. */
function code(value) {
  return oneLine(value).replace(/`/g, "'");
}

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/**
 * The original code a mutant replaces. Stryker's JSON `source` is the original
 * file, and locations are 1-based line and column; slice it back out so the
 * report can show `original → replacement` without re-reading the worktree.
 */
export function extractOriginal(source, location) {
  if (typeof source !== 'string' || !location?.start) return '';
  const starts = lineStarts(source);
  const toOffset = ({ line, column }) => {
    const base = starts[line - 1];
    if (base === undefined || !Number.isFinite(column)) return undefined;
    return base + (column - 1);
  };
  const start = toOffset(location.start);
  if (start === undefined) return '';
  const end = location.end ? toOffset(location.end) : undefined;
  return source.slice(start, end === undefined ? start + 1 : end);
}

/**
 * Stryker's score: detected (killed + timeout) over valid (detected + survived
 * + no-coverage). Timeout counts as killed so the table's "killed" column adds
 * up against the score.
 */
export function fileMetrics(mutants) {
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const mutant of mutants ?? []) {
    if (mutant.status === 'Killed' || mutant.status === 'Timeout') killed++;
    else if (mutant.status === 'Survived') survived++;
    else if (mutant.status === 'NoCoverage') noCoverage++;
  }
  const valid = killed + survived + noCoverage;
  return {
    killed,
    survived,
    noCoverage,
    valid,
    score: valid > 0 ? (killed / valid) * 100 : null,
  };
}

export function overallMetrics(files) {
  const mutants = [];
  for (const result of Object.values(files ?? {})) mutants.push(...(result?.mutants ?? []));
  return fileMetrics(mutants);
}

function survivingMutants(result) {
  return (result?.mutants ?? [])
    .filter((mutant) => UNDETECTED.has(mutant.status))
    .sort(
      (a, b) =>
        (a.location?.start?.line ?? 0) - (b.location?.start?.line ?? 0),
    );
}

function filesBelowThreshold(report, threshold) {
  const below = [];
  for (const [path, result] of Object.entries(report?.files ?? {})) {
    const metrics = fileMetrics(result?.mutants);
    if (metrics.valid > 0 && threshold != null && metrics.score < threshold) {
      below.push({ path, metrics, result });
    }
  }
  below.sort(
    (a, b) => a.metrics.score - b.metrics.score || a.path.localeCompare(b.path),
  );
  return below;
}

/** The run-summary Markdown. Pure over the report and threshold so tests can assert exact text. */
export function buildMiniReport({ report, threshold }) {
  const lines = ['## Mutation score', ''];
  const overall = overallMetrics(report?.files);

  if (overall.valid === 0) {
    lines.push('No mutants were reported — nothing to compare.');
    return lines.join('\n');
  }

  const scoreText = `${fmt(overall.score)}%`;
  if (threshold == null) {
    lines.push(`**Overall: ${scoreText}** (break threshold unavailable)`);
  } else {
    const pass = overall.score >= threshold;
    lines.push(
      `**Overall: ${scoreText}** ${pass ? '✅' : '❌'} (break threshold ${fmt(threshold)}%)`,
    );
  }

  const below = filesBelowThreshold(report, threshold);
  if (below.length === 0) {
    if (threshold != null) {
      lines.push('', `No file is below the ${fmt(threshold)}% break threshold.`);
    }
    return lines.join('\n');
  }

  lines.push('', '| File | Score | Killed | Survived | No cov |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const { path, metrics } of below) {
    lines.push(
      `| \`${path}\` | ${fmt(metrics.score)}% | ${metrics.killed} | ${metrics.survived} | ${metrics.noCoverage} |`,
    );
  }

  lines.push('', `### Surviving mutants (top ${MAX_MUTANTS_PER_FILE} per file)`);
  for (const { path, metrics, result } of below) {
    lines.push('', `#### \`${path}\` — ${fmt(metrics.score)}%`);
    const survivors = survivingMutants(result).slice(0, MAX_MUTANTS_PER_FILE);
    if (survivors.length === 0) lines.push('- (no surviving mutants recorded)');
    for (const mutant of survivors) {
      const line = mutant.location?.start?.line ?? '?';
      const original = code(extractOriginal(result.source, mutant.location));
      const replacement = code(mutant.replacement);
      lines.push(
        `- \`${path}:${line}\` · ${mutant.mutatorName} · \`${original}\` → \`${replacement}\``,
      );
    }
  }
  return lines.join('\n');
}

/**
 * `::warning` lines for surviving mutants in files the PR changed, worst files
 * first. GitHub caps annotation output per step, so stop at `max`.
 */
export function buildAnnotations({ report, changedFiles = [], max = MAX_ANNOTATIONS }) {
  const changed = new Set(changedFiles.map(normalizePath));
  const candidates = [];
  for (const [path, result] of Object.entries(report?.files ?? {})) {
    if (!changed.has(normalizePath(path))) continue;
    const metrics = fileMetrics(result?.mutants);
    if (metrics.valid === 0) continue;
    candidates.push({ path, score: metrics.score, result });
  }
  candidates.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));

  const annotations = [];
  for (const { path, result } of candidates) {
    for (const mutant of survivingMutants(result)) {
      if (annotations.length >= max) return annotations;
      const line = mutant.location?.start?.line;
      if (line == null) continue;
      const original = oneLine(extractOriginal(result.source, mutant.location));
      const replacement = oneLine(mutant.replacement);
      const title = mutant.status === 'NoCoverage' ? 'Mutant not covered' : 'Mutant survived';
      const message = `${mutant.mutatorName}: ${original} → ${replacement}`;
      annotations.push(
        `::warning file=${escapeProperty(path)},line=${line},title=${escapeProperty(title)}::${escapeData(message)}`,
      );
    }
  }
  return annotations;
}

export function loadReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) {
    return { ok: false, reason: `No mutation report at \`${reportPath ?? DEFAULT_REPORT}\`.` };
  }
  try {
    return { ok: true, report: JSON.parse(readFileSync(reportPath, 'utf8')) };
  } catch (error) {
    return {
      ok: false,
      reason: `The mutation report at \`${reportPath}\` is not valid JSON: ${error.message}`,
    };
  }
}

/** Break threshold from the Stryker config; the report's own thresholds are the fallback. */
export function loadThreshold(configPath, report) {
  if (configPath && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const value = config?.thresholds?.break;
      if (typeof value === 'number') return value;
    } catch {
      // Fall through to the report's own thresholds below.
    }
  }
  const fallback = report?.thresholds?.break;
  return typeof fallback === 'number' ? fallback : null;
}

export function loadChangedFiles(changedPath) {
  if (!changedPath || !existsSync(changedPath)) return [];
  return readFileSync(changedPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function unavailableMarkdown(reason) {
  return [
    '## Mutation score',
    '',
    `⚠️ ${reason}`,
    '',
    'The HTML report, if one was produced, is in the `mutation-report` artifact.',
  ].join('\n');
}

function writeSummary(summaryPath, markdown) {
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, `${markdown}\n`);
  } catch {
    // A summary we cannot write must not fail the job on its own.
  }
}

/**
 * Read the report, render both outputs, and (when asked) append the Markdown
 * to `$GITHUB_STEP_SUMMARY`. Never throws for a missing/malformed input.
 */
export function run({
  reportPath = DEFAULT_REPORT,
  configPath = DEFAULT_CONFIG,
  changedPath,
  summaryPath,
  annotate = true,
} = {}) {
  const loaded = loadReport(reportPath);
  if (!loaded.ok) {
    const markdown = unavailableMarkdown(loaded.reason);
    writeSummary(summaryPath, markdown);
    return { exitCode: 0, markdown, annotations: [] };
  }

  const threshold = loadThreshold(configPath, loaded.report);
  const changedFiles = loadChangedFiles(changedPath);

  // A structurally malformed report (e.g. a null file entry) must degrade to a
  // message, not exit non-zero: Stryker owns the verdict, so a throw here
  // would fail the job for the wrong reason.
  let markdown;
  try {
    markdown = buildMiniReport({ report: loaded.report, threshold });
  } catch (error) {
    markdown = unavailableMarkdown(`The mutation report could not be read: ${error.message}`);
  }

  let annotations = [];
  if (annotate) {
    try {
      annotations = buildAnnotations({ report: loaded.report, changedFiles });
    } catch {
      annotations = [];
    }
  }

  writeSummary(summaryPath, markdown);
  return { exitCode: 0, markdown, annotations };
}

export function parseArgs(argv) {
  const args = {
    reportPath: DEFAULT_REPORT,
    configPath: DEFAULT_CONFIG,
    changedPath: undefined,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
    annotate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--report') args.reportPath = argv[++i];
    else if (flag === '--config') args.configPath = argv[++i];
    else if (flag === '--changed') args.changedPath = argv[++i];
    else if (flag === '--summary') args.summaryPath = argv[++i];
    else if (flag === '--no-annotate') args.annotate = false;
  }
  return args;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const { markdown, annotations } = run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${markdown}\n`);
  for (const annotation of annotations) process.stdout.write(`${annotation}\n`);
}
