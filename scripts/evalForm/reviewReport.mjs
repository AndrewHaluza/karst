// Review-findings bench report: Wilson 95% intervals, INSUFFICIENT below MIN_N, no ranking below MIN_N.
import { cell } from './report.mjs';

export const MIN_N = 30;
const Z = 1.96;

/** Wilson 95% interval for k of n. `null` when n is 0. */
export function wilson(k, n) {
  if (n === 0) return null;
  const p = k / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const rate = (k, n) => ({ k, n, interval: wilson(k, n), insufficient: n < MIN_N });
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * One candidate over its runs. Recall is found / seeded defects over runs that finished.
 * `cleanFailed` is the share of clean-case runs with at least one false finding.
 */
export function summarizeCandidate(runs) {
  const done = runs.filter((r) => r.status === 'ok');
  const clean = done.filter((r) => r.clean);
  return {
    runs: runs.length,
    recall: rate(done.reduce((n, r) => n + r.found, 0), done.reduce((n, r) => n + r.seeded, 0)),
    cleanFailed: rate(clean.filter((r) => r.caseFailed).length, clean.length),
    blockingFalse: done.reduce((n, r) => n + r.blockingFalse, 0),
    errors: runs.filter((r) => r.status === 'error').length,
    timeouts: runs.filter((r) => r.status === 'timeout').length,
    meanTokens: mean(done.map((r) => r.tokens).filter((t) => typeof t === 'number')),
    meanSeconds: mean(done.map((r) => r.seconds).filter((t) => typeof t === 'number')),
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const fmtRate = (r) => {
  if (r.n === 0) return 'n/a';
  const base = `${r.k}/${r.n} ${pct(r.interval.p)} [${pct(r.interval.lo)}, ${pct(r.interval.hi)}]`;
  return r.insufficient ? `${base} INSUFFICIENT` : base;
};
const fmtNum = (v, d = 0) => (v === null ? 'n/a' : v.toFixed(d));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

/** Markdown report. Candidates are listed in input order and never ranked while any cell has n below MIN_N. */
export function renderReviewReport({ command, caseSetVersion, buildSha, coreVersions, candidates }) {
  const rows = candidates.map((c) => ({ c, s: summarizeCandidate(c.runs) }));
  const table1 = table(
    ['core', 'model', 'effort', 'runs', 'recall', 'clean cases with a false finding', 'blocking false', 'errors', 'timeouts', 'tokens/run', 'seconds/run'],
    rows.map(({ c, s }) => [cell(c.core), cell(c.model), cell(c.effort ?? 'default'), s.runs, fmtRate(s.recall), fmtRate(s.cleanFailed), s.blockingFalse, s.errors, s.timeouts, fmtNum(s.meanTokens), fmtNum(s.meanSeconds, 1)]),
  );
  const enough = rows.every(({ s }) => !s.recall.insufficient && !s.cleanFailed.insufficient);
  return [
    '# Review findings bench',
    '',
    `Command: \`${command}\``,
    `Case-set version: ${caseSetVersion}`,
    `Build SHA: ${buildSha}`,
    `Core versions: ${Object.entries(coreVersions ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'unknown'}`,
    '',
    table1,
    '',
    ...rows.map(({ c, s }) => `${cell(c.core)}: ${s.errors + s.timeouts} of ${s.runs} calls did not finish.`),
    'Recall and false-finding rates count only the runs that finished ok.',
    '',
    enough ? 'Candidates have enough runs to compare.' : `No ranking: a cell has n below ${MIN_N}. Do not draw a conclusion from it.`,
    '',
  ].join('\n');
}
