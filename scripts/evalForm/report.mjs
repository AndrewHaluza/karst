// eval-results/form-<ts>/report.md: per-source summary + per-input spot-check view.
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
export const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const num = (v, d = 2) => (v === null || v === undefined ? 'pending' : v.toFixed(d));
const pct = (v) => (v === null || v === undefined ? 'pending' : `${(v * 100).toFixed(1)}%`);
export const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

export const failureList = (a) => {
  const f = [];
  if (a.error) f.push(`call-error: ${a.error}`);
  if (a.checks) {
    if (a.checks.verbatim.missing.length) f.push(`missing verbatim: ${a.checks.verbatim.missing.join(', ')}`);
    f.push(...a.checks.contract.map((v) => `contract: ${v}`));
    if (a.checks.injection && !a.checks.injection.ok) f.push(`injection: obeyed=${a.checks.injection.obeyed} note=${a.checks.injection.note}`);
    if (a.checks.tight && !a.checks.tight.ok) f.push(`not tight (sim ${a.checks.tight.sim.toFixed(2)})`);
  }
  return f;
};

/** Summary of one prompt source over its attempts. Missing measurements stay null ("pending"), never 0. */
export function summarizeSource(attempts) {
  const ok = attempts.filter((a) => !a.error);
  const judged = ok.filter((a) => a.judge?.ok);
  const verb = ok.map((a) => a.checks.verbatim.pct).filter((v) => v !== null);
  const inj = ok.filter((a) => a.checks.injection);
  const tight = ok.filter((a) => a.checks.tight);
  const lost = judged.map((a) => a.judge.lost.length);
  const inv = judged.map((a) => a.judge.invented.length);
  const tokens = ok.map((a) => a.usage && a.usage.inputTokens + a.usage.outputTokens).filter((v) => typeof v === 'number');
  return {
    calls: attempts.length, callErrors: attempts.length - ok.length,
    verbatimPct: mean(verb),
    contractViolations: ok.reduce((n, a) => n + a.checks.contract.length, 0),
    injectionHandled: inj.length ? inj.filter((a) => a.checks.injection.ok).length / inj.length : null,
    tightUnchanged: tight.length ? tight.filter((a) => a.checks.tight.ok).length / tight.length : null,
    lostMean: mean(lost), invMean: mean(inv),
    judgeErrors: ok.length - judged.length,
    // spread over runs: sd of per-run means
    spread: { lost: runSd(judged, (a) => a.judge.lost.length), invented: runSd(judged, (a) => a.judge.invented.length), words: runSd(ok, (a) => a.checks.words) },
    tokensPerCall: mean(tokens),
    secondsPerCall: mean(ok.map((a) => a.seconds).filter((v) => typeof v === 'number')),
  };
}

function runSd(attempts, pick) {
  const byRun = new Map();
  for (const a of attempts) byRun.set(a.run, [...(byRun.get(a.run) ?? []), pick(a)]);
  return sd([...byRun.values()].map(mean));
}

/** meta: {startedAt, model, judgeModel, provider, runs, sources: string[]}; attempts: [{caseId, source, run, output, error, checks, judge, usage, seconds}]; cases: [{id,title,type,input}] */
export function renderReport({ meta, cases, attempts }) {
  const out = ['# Form improve eval', ''];
  out.push(`- pass: improve; provider ${meta.provider}; model \`${meta.model}\`; judge \`${meta.judgeModel}\`; runs ${meta.runs}; started ${meta.startedAt}`);
  out.push('- contract checks are the BUILT-IN prompt contract, applied to every source (improve has no prompt floor).');
  out.push('- judge-errors are counted and excluded from lost/invented means; `pending` = not reported, never 0.', '', '## Per prompt source', '');
  const sums = Object.fromEntries(meta.sources.map((s) => [s, summarizeSource(attempts.filter((a) => a.source === s))]));
  out.push(table(
    ['source', 'calls', 'call errors', 'verbatim kept', 'contract violations', 'injection handled', 'tight unchanged', 'lost (mean)', 'invented (mean)', 'judge errors', 'sd lost/inv/words', 'tokens/call', 's/call'],
    meta.sources.map((s) => {
      const x = sums[s];
      return [s, x.calls, x.callErrors, pct(x.verbatimPct), x.contractViolations, pct(x.injectionHandled), pct(x.tightUnchanged), num(x.lostMean), num(x.invMean), x.judgeErrors,
        `${num(x.spread.lost)} / ${num(x.spread.invented)} / ${num(x.spread.words, 1)}`, num(x.tokensPerCall, 0), num(x.secondsPerCall, 1)];
    }),
  ));
  out.push('', '## Per input (run 1 output; all runs in results.json)', '');
  for (const c of cases) {
    out.push(`### ${c.id} (${c.type}) ${c.title}`, '', '**Source**', '', '```text', c.input, '```', '');
    const rows = meta.sources.map((s) => {
      const a = attempts.find((x) => x.caseId === c.id && x.source === s && x.run === 1);
      if (!a) return [s, 'pending', '', ''];
      const j = a.judge?.ok
        ? `lost: ${a.judge.lost.map((l) => l.item).join('; ') || 'none'}<br>invented: ${a.judge.invented.map((l) => l.item).join('; ') || 'none'}`
        : (a.judge?.error ?? 'judge-error');
      return [s, cell(a.output ?? ''), cell(j), cell(failureList(a).join('; ') || 'none')];
    });
    out.push(table(['source', 'output', 'judge', 'check failures'], rows), '');
  }
  return out.join('\n');
}
