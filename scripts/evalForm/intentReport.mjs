// Intent pass report: per source mode summary + per-instance spot-check view.
import { coverageScore } from './intentJudge.mjs';
import { cell, sd } from './report.mjs';

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const num = (v, d = 2) => (v === null || v === undefined ? 'pending' : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? 'pending' : `${(v * 100).toFixed(1)}%`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const TRUNC = 600;
const trunc = (s) => (s.length > TRUNC ? `${s.slice(0, TRUNC)}…` : s);

/** Per-run coverage: sum of weighted covered / denominator over all judged instances (judge-errors excluded). */
function perRunCoverage(judged) {
  const byRun = new Map();
  for (const a of judged) {
    const s = coverageScore(a.judge.tests);
    const cur = byRun.get(a.run) ?? { num: 0, den: 0 };
    byRun.set(a.run, { num: cur.num + s.covered + 0.5 * s.partial, den: cur.den + s.den });
  }
  return [...byRun.values()].filter((r) => r.den > 0).map((r) => r.num / r.den);
}

export function summarizeMode(attempts) {
  const ok = attempts.filter((a) => !a.error);
  const judged = ok.filter((a) => a.judge?.ok);
  const scores = judged.map((a) => coverageScore(a.judge.tests));
  const runs = perRunCoverage(judged);
  const count = (o) => ok.filter((a) => a.checks.outcome === o).length;
  const tokens = ok.map((a) => a.usage && a.usage.inputTokens + a.usage.outputTokens).filter((v) => typeof v === 'number');
  return {
    calls: attempts.length, callErrors: attempts.length - ok.length,
    coverage: mean(runs), spread: sd(runs),
    missing: scores.reduce((n, s) => n + s.missing, 0), notInIssue: scores.reduce((n, s) => n + s.notInIssue, 0),
    unsupportedMean: mean(judged.map((a) => a.judge.unsupported.length)),
    judgeErrors: ok.filter((a) => a.judge && !a.judge.ok).length,
    outcomes: { first: count('first-try'), nudged: count('nudged'), degraded: count('degraded') },
    scenariosMean: mean(ok.filter((a) => a.checks.outcome !== 'degraded').map((a) => a.checks.scenarios)),
    nonGwt: ok.reduce((n, a) => n + a.checks.nonGwt, 0),
    pathCharters: ok.filter((a) => a.checks.pathTokens.length > 0).length,
    leaks: ok.reduce((n, a) => n + a.checks.leaks.length, 0),
    tokensPerCall: mean(tokens), secondsPerCall: mean(ok.map((a) => a.seconds).filter((v) => typeof v === 'number')),
  };
}

export function renderIntentReport({ meta, items, attempts }) {
  const out = ['# Form intent eval', ''];
  out.push(`- pass: intent; provider ${meta.provider}; model \`${meta.model}\`; judge \`${meta.judgeModel}\`; runs ${meta.runs}; started ${meta.startedAt}`);
  out.push('- F2P coverage: covered=1, partial=0.5; only tests whose behaviour the ISSUE states count (`not-in-issue` leaves the denominator). Spread = sd over runs.');
  out.push('- judge-errors are counted and excluded, never 0; `pending` = not reported. Function/API identifiers are info only, not a violation. Leaks should be 0 (proves the guard).', '', '## Per source mode', '');
  out.push(table(
    ['source', 'calls', 'call errors', 'F2P coverage', 'sd', 'missing', 'not-in-issue', 'unsupported/charter', 'parse first/nudged/degraded', 'scenarios', 'non-GWT', 'charters w/ paths', 'leaks', 'judge errors', 'tokens/call', 's/call'],
    meta.sources.map((s) => {
      const x = summarizeMode(attempts.filter((a) => a.source === s));
      return [s, x.calls, x.callErrors, pct(x.coverage), num(x.spread), x.missing, x.notInIssue, num(x.unsupportedMean), `${x.outcomes.first}/${x.outcomes.nudged}/${x.outcomes.degraded}`,
        num(x.scenariosMean, 1), x.nonGwt, x.pathCharters, x.leaks, x.judgeErrors, num(x.tokensPerCall, 0), num(x.secondsPerCall, 1)];
    }),
  ));
  out.push('', '## Per instance (run 1; all runs in results.json)', '');
  for (const it of items) {
    out.push(`### ${it.id}: ${it.title}`, '', '**Issue (truncated)**', '', '```text', trunc(it.brief), '```', '');
    const rows = meta.sources.map((s) => {
      const a = attempts.find((x) => x.caseId === it.id && x.source === s && x.run === 1);
      if (!a) return [s, 'pending', '', ''];
      if (a.error) return [s, `call-error: ${cell(a.error)}`, '', ''];
      const cov = a.judge?.ok ? a.judge.tests.map((t) => `${cell(t.test.split(' > ').slice(-1)[0])}: **${t.coverage}**${t.scenario ? ` (s${t.scenario})` : ''} — ${cell(t.why)}`).join('<br>') || 'no F2P tests' : (a.judge?.error ?? (a.charter === null ? 'degraded: no charter' : 'judge-error'));
      const uns = a.judge?.ok ? a.judge.unsupported.map((u) => `s${u.scenario}: ${cell(u.why)}`).join('<br>') || 'none' : '';
      return [s, cell(a.charter ?? '(degraded)'), cov, uns];
    });
    out.push(table(['source', 'charter', 'per-test coverage', 'unsupported'], rows), '');
  }
  return out.join('\n');
}
