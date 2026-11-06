// eval-results/rejudge-<ts>/report.md: one leaderboard per pass per judge, old judge numbers next to the new ones.
import { coverageScore } from './intentJudge.mjs';
import { LOW_N, CHECKER_VERSION, producerLabel, vendorOf } from './rejudge.mjs';

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const num = (v, d = 2) => (v === null || v === undefined ? 'pending' : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? 'pending' : `${(v * 100).toFixed(1)}%`);
const delta = (n, o, d = 2) => (n === null || o === null ? 'n/a' : `${n - o >= 0 ? '+' : ''}${(n - o).toFixed(d)}`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const groupBy = (xs, key) => { const m = new Map(); for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]); return m; };
const improveKey = (e, multiSource) => `${producerLabel(e.producer)}${multiSource ? ` · ${e.source}` : ''}`;
const nCases = (es) => new Set(es.map((e) => e.caseId)).size;
const runsOf = (es) => new Set(es.map((e) => e.run)).size;
const low = (n) => (n < LOW_N ? ' LOW' : '');

/** Same lost/invented counts (improve) or same coverage labels (intent) from two judges. */
export function agree(a, b, pass) {
  if (!a?.ok || !b?.ok) return null;
  if (pass === 'intent') return a.tests.map((t) => t.coverage).join() === b.tests.map((t) => t.coverage).join();
  return a.lost.length === b.lost.length && a.invented.length === b.invented.length;
}

const flagCell = (rowEntries, judge) => {
  const jv = vendorOf(judge);
  return jv && rowEntries.some((e) => vendorOf(e.producer.model) === jv) ? 'self-family' : '';
};

function improveRows(entries, j, judge) {
  const multi = new Set(entries.map((e) => e.source)).size > 1;
  return [...groupBy(entries, (e) => improveKey(e, multi))].map(([label, es]) => {
    const judged = es.filter((e) => e.judged?.[j]?.ok);
    const lost = mean(judged.map((e) => e.judged[j].lost.length));
    const inv = mean(judged.map((e) => e.judged[j].invented.length));
    const old = es.filter((e) => e.oldJudge?.ok);
    const oldLost = mean(old.map((e) => e.oldJudge.lost.length));
    const oldInv = mean(old.map((e) => e.oldJudge.invented.length));
    const verb = mean(es.map((e) => e.checks.verbatim.pct).filter((v) => v !== null));
    return [label, `${nCases(es)}${low(nCases(es))}`, runsOf(es), num(lost), num(oldLost), delta(lost, oldLost), num(inv), num(oldInv), delta(inv, oldInv), pct(verb),
      es.reduce((n, e) => n + e.checks.contract.length, 0), es.filter((e) => e.judged?.[j] && !e.judged[j].ok).length, flagCell(es, judge)];
  });
}

const IMPROVE_HEAD = ['producer', 'n cases', 'runs', 'lost/case', 'old lost', 'Δ', 'invented/case', 'old inv', 'Δ', 'verbatim', 'contract violations', 'judge errors', 'flag'];

/** Per-run coverage over judged attempts of one source (same maths as the intent report). */
function coverageFor(es, pick) {
  const byRun = new Map();
  for (const e of es) {
    const s = coverageScore(pick(e).tests);
    const cur = byRun.get(e.run) ?? { n: 0, den: 0 };
    byRun.set(e.run, { n: cur.n + s.covered + 0.5 * s.partial, den: cur.den + s.den });
  }
  return mean([...byRun.values()].filter((r) => r.den > 0).map((r) => r.n / r.den));
}

function intentRows(entries, j, judge, sources) {
  return [...groupBy(entries, (e) => producerLabel(e.producer))].map(([label, es]) => {
    const cov = sources.map((s) => {
      const xs = es.filter((e) => e.source === s);
      const nw = coverageFor(xs.filter((e) => e.judged?.[j]?.ok), (e) => e.judged[j]);
      const od = coverageFor(xs.filter((e) => e.oldJudge?.ok), (e) => e.oldJudge);
      return `${pct(nw)} (old ${pct(od)}, Δ ${delta(nw, od, 3)})`;
    });
    const judged = es.filter((e) => e.judged?.[j]?.ok);
    const full = judged.filter((e) => { const s = coverageScore(e.judged[j].tests); return s.den > 0 && s.covered === s.den; }).length;
    const unsup = mean(judged.map((e) => e.judged[j].unsupported.length));
    const oldUnsup = mean(es.filter((e) => e.oldJudge?.ok).map((e) => e.oldJudge.unsupported.length));
    return [label, `${nCases(es)}${low(nCases(es))}`, runsOf(es), ...cov, full, `${num(unsup)} (old ${num(oldUnsup)})`, es.filter((e) => e.judged?.[j] && !e.judged[j].ok).length, flagCell(es, judge)];
  });
}

function passSection(pass, entries, judges) {
  const out = [`## ${pass} pass`, ''];
  const sources = [...new Set(entries.map((e) => e.source))];
  judges.forEach((judge, j) => {
    out.push(`### judge \`${judge}\``, '');
    out.push(pass === 'intent'
      ? table(['producer', 'n cases', 'runs', ...sources.map((s) => `coverage ${s}`), 'full-covered tasks', 'unsupported/charter', 'judge errors', 'flag'], intentRows(entries, j, judge, sources))
      : table(IMPROVE_HEAD, improveRows(entries, j, judge)), '');
  });
  if (judges.length > 1) {
    const rows = judges.slice(1).map((judge, i) => {
      const pairs = entries.map((e) => agree(e.judged?.[0], e.judged?.[i + 1], pass)).filter((v) => v !== null);
      return [`\`${judges[0]}\` vs \`${judge}\``, pairs.length, pct(pairs.length ? pairs.filter(Boolean).length / pairs.length : null)];
    });
    out.push('### panel agreement', '', table(['judges', 'attempts compared', 'agree'], rows), '');
  }
  return out;
}

/** summary: {judges, entries, calls, maxCalls, stopped, selfId} */
export function renderRejudgeReport({ judges, entries, stopped, maxCalls, files, seed, effort }) {
  const out = ['# Form rejudge', ''];
  out.push(`- judges: ${judges.map((j) => `\`${j}\``).join(', ')} (effort ${effort}); seed ${seed}; sources ${files} result file(s); no producer was called.`);
  out.push(`- deterministic checks recomputed with the current checkers (${CHECKER_VERSION}). \`LOW\` = n cases < ${LOW_N}. \`self-family\` = judge vendor equals producer vendor (self-preference risk). Old = the judge stored in the saved run.`);
  if (entries.some((e) => e.pass === 'intent')) out.push('- intent: each judge decides `not-in-issue` once per case, without a charter. An old score can come from a run where the judge decided it for each charter, so its denominator can differ.');
  const skipped = entries.filter((e) => e.skip);
  const count = (r) => skipped.filter((e) => e.skip === r).length;
  out.push(`- unavailable(no-input): ${count('no-input')}; no output to judge (call error / degraded): ${count('no-output')}.`);
  if (stopped) out.push(`- PARTIAL: stopped at --max-calls ${maxCalls}; unjudged attempts show as judge errors.`);
  out.push('');
  for (const pass of ['improve', 'intent']) {
    const es = entries.filter((e) => e.pass === pass && !e.skip);
    if (es.length) out.push(...passSection(pass, es, judges));
  }
  const leaks = entries.filter((e) => e.selfId?.length);
  out.push('## Possible blinding leaks (judged as-is)', '');
  out.push(leaks.length ? table(['pass', 'case', 'source', 'run', 'terms'], leaks.map((e) => [e.pass, e.caseId, e.source, e.run, e.selfId.join(', ')])) : 'none', '');
  return out.join('\n');
}
