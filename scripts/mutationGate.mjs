#!/usr/bin/env node
/**
 * Delta gate for the `Mutation score` job (.github/workflows/ci.yml).
 *
 * The old gate failed a PR when the GLOBAL Stryker score was below
 * `thresholds.break`, so a develop that dropped under 85 blocked every PR that
 * touched `src/**`. This gate fails a PR only for what the PR itself does, per
 * changed file that is in the Stryker `mutate` set (the PR report only holds
 * mutate-set files, so "in the report" means "in the mutate set"):
 *
 *   a. the file is in develop's report and has MORE undetected mutants
 *      (Survived + NoCoverage) than there;
 *   b. the file is not in develop's report (new, renamed, or no develop report
 *      at all) and its file score is below `thresholds.break`.
 *
 * A global score below the break is a `::warning` and a summary line only.
 * Stryker does not decide pass/fail on a PR; this script does. A missing or
 * malformed PR report fails closed. A missing or malformed develop report
 * means rule b for every changed file (never the global score).
 */
import { appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  DEFAULT_REPORT,
  fileMetrics,
  loadChangedFiles,
  loadReport,
  loadThreshold,
  normalizePath,
  overallMetrics,
} from './mutationSummary.mjs';

export const DEFAULT_THRESHOLD = 85;

function fmt(value) {
  return value === null ? 'n/a' : Number(value).toFixed(2);
}

/** A Stryker report has an object `files` whose entries each hold a `mutants` array. */
export function validateReport(report) {
  const files = report?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return 'it has no `files` object';
  }
  for (const [path, result] of Object.entries(files)) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.mutants)) {
      return `the entry for \`${path}\` has no \`mutants\` array`;
    }
  }
  return null;
}

/** Load and validate one side. `files` is null when the report is unusable. */
export function loadSide(path, label) {
  const loaded = loadReport(path);
  if (!loaded.ok) return { files: null, report: null, reason: `${label}: ${loaded.reason}` };
  const problem = validateReport(loaded.report);
  if (problem) {
    return {
      files: null,
      report: null,
      reason: `${label}: the mutation report is malformed: ${problem}.`,
    };
  }
  return { files: loaded.report.files, report: loaded.report, reason: null };
}

function indexByPath(files) {
  const index = new Map();
  for (const [path, result] of Object.entries(files)) index.set(normalizePath(path), result);
  return index;
}

/**
 * Decide the verdict per changed mutate-set file.
 * `developFiles` is null when no usable develop report exists (rule 4).
 */
export function evaluate({ prFiles, developFiles, changedFiles, threshold }) {
  const pr = indexByPath(prFiles);
  const develop = developFiles ? indexByPath(developFiles) : null;
  const rows = [];
  const seen = new Set();
  for (const raw of changedFiles) {
    const path = normalizePath(raw);
    if (seen.has(path) || !pr.has(path)) continue;
    seen.add(path);
    const metrics = fileMetrics(pr.get(path).mutants);
    const prUndetected = metrics.survived + metrics.noCoverage;
    const developResult = develop?.get(path);
    const row = { path, prUndetected, score: metrics.score, developUndetected: null };
    if (developResult) {
      const dm = fileMetrics(developResult.mutants);
      row.developUndetected = dm.survived + dm.noCoverage;
      row.failed = prUndetected > row.developUndetected;
      row.verdict = row.failed
        ? `FAIL: ${prUndetected - row.developUndetected} more undetected than develop`
        : 'pass';
    } else {
      row.failed = metrics.score !== null && metrics.score < threshold;
      if (row.failed) row.verdict = `FAIL: new file, score below ${threshold}`;
      else if (metrics.score === null) row.verdict = 'pass (no mutants)';
      else row.verdict = 'pass (new file)';
    }
    rows.push(row);
  }
  return rows;
}

export function buildMarkdown({ rows, notes, globalScore, threshold }) {
  const lines = ['## Mutation score', ''];
  for (const note of notes) lines.push(`⚠️ ${note}`, '');
  if (globalScore !== null && globalScore < threshold) {
    lines.push(
      `⚠️ Global mutation score ${fmt(globalScore)} is below thresholds.break (${threshold}). This does not fail the PR.`,
      '',
    );
  } else if (globalScore !== null) {
    lines.push(`Global mutation score: ${fmt(globalScore)} (break ${threshold}).`, '');
  }
  if (rows.length === 0) {
    lines.push('No changed file is in the Stryker `mutate` set.');
    return lines.join('\n');
  }
  lines.push(
    '| File | Develop undetected | PR undetected | File score | Verdict |',
    '|---|---:|---:|---:|---|',
  );
  for (const row of rows) {
    const dev = row.developUndetected === null ? 'n/a' : String(row.developUndetected);
    lines.push(
      `| \`${row.path}\` | ${dev} | ${row.prUndetected} | ${fmt(row.score)} | ${row.verdict} |`,
    );
  }
  return lines.join('\n');
}

export function run({
  reportPath = DEFAULT_REPORT,
  developReportPath,
  configPath = DEFAULT_CONFIG,
  changedPath,
  summaryPath,
} = {}) {
  const notes = [];
  const annotations = [];
  const write = (markdown) => {
    if (!summaryPath) return;
    try {
      appendFileSync(summaryPath, `${markdown}\n`);
    } catch {
      // A summary we cannot write must not change the verdict.
    }
  };

  const prSide = loadSide(reportPath, 'PR report');
  if (!prSide.files) {
    const markdown = ['## Mutation score', '', `❌ ${prSide.reason} The gate fails closed.`].join(
      '\n',
    );
    write(markdown);
    return { exitCode: 1, markdown, annotations: [`::error::${prSide.reason}`] };
  }

  const threshold = loadThreshold(configPath, prSide.report) ?? DEFAULT_THRESHOLD;
  let developFiles = null;
  if (!developReportPath || !existsSync(developReportPath)) {
    notes.push(
      'No develop mutation report is available: every changed file must reach the break score on its own.',
    );
  } else {
    const developSide = loadSide(developReportPath, 'Develop report');
    if (developSide.files) developFiles = developSide.files;
    else
      notes.push(
        `${developSide.reason} Every changed file must reach the break score on its own.`,
      );
  }

  const rows = evaluate({
    prFiles: prSide.files,
    developFiles,
    changedFiles: loadChangedFiles(changedPath),
    threshold,
  });
  const globalScore = overallMetrics(prSide.files).score;
  if (globalScore !== null && globalScore < threshold) {
    annotations.push(
      `::warning::Global mutation score ${fmt(globalScore)} is below thresholds.break (${threshold}). This does not fail the PR.`,
    );
  }
  const markdown = buildMarkdown({ rows, notes, globalScore, threshold });
  write(markdown);
  return { exitCode: rows.some((row) => row.failed) ? 1 : 0, markdown, annotations };
}

export function parseArgs(argv) {
  const args = {
    reportPath: DEFAULT_REPORT,
    developReportPath: undefined,
    configPath: DEFAULT_CONFIG,
    changedPath: undefined,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--report') args.reportPath = argv[++i];
    else if (flag === '--develop-report') args.developReportPath = argv[++i];
    else if (flag === '--config') args.configPath = argv[++i];
    else if (flag === '--changed') args.changedPath = argv[++i];
    else if (flag === '--summary') args.summaryPath = argv[++i];
  }
  return args;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const { exitCode, markdown, annotations } = run(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${markdown}\n`);
  for (const annotation of annotations) process.stdout.write(`${annotation}\n`);
  process.exitCode = exitCode;
}
