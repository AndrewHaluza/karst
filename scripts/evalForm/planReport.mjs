// Planner bench report: per model means, per case rows, and the PLANNER-MODEL-RATINGS table (written only with --publish).
import { cell } from './report.mjs';

const num = (v, d = 2) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const WEIGHT = { covered: 1, partial: 0.5, none: 0 };
// totalTokens includes cache read/write (the bulk of a multi-turn agent run); in+out alone undercounts ~20x.
const total = (u) => (u ? u.totalTokens ?? u.inputTokens + u.outputTokens : null);
const sum = (xs) => { const v = xs.filter((t) => t !== null); return v.length === 0 ? null : v.reduce((a, b) => a + b, 0); };

/** judge-error rows count in `judgeErrors` and never enter a mean. */
export function summarizePlan(results) {
  const ok = results.filter((r) => r.judge?.ok);
  const cov = ok.flatMap((r) => r.judge.f2pCoverage.map((c) => WEIGHT[c.coverage]));
  const withDrafts = results.filter((r) => r.defects);
  return {
    total: results.length,
    scored: ok.length,
    judgeErrors: results.filter((r) => r.judge && !r.judge.ok).length,
    noDraft: results.filter((r) => r.status === 'no-draft' || r.status === 'invalid-proposal').length,
    timeouts: results.filter((r) => r.status === 'timeout').length,
    errors: results.filter((r) => r.status === 'error').length,
    notDone: mean(ok.map((r) => r.judge.notDone.length)),
    unrequested: mean(ok.map((r) => r.judge.unrequested.length)),
    f2p: mean(cov),
    defectRate: withDrafts.length === 0 ? null : withDrafts.filter((r) => r.defects.length > 0).length / withDrafts.length,
    plannerTokens: sum(results.map((r) => total(r.usage))),
    judgeTokens: sum(results.map((r) => total(r.judge?.usage))),
  };
}

const byModel = (results) => {
  const g = new Map();
  for (const r of results) g.set(r.model, [...(g.get(r.model) ?? []), r]);
  return [...g.entries()].map(([model, rs]) => ({ model, s: summarizePlan(rs) }));
};
const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
const rank = (a, b) => (a.s.notDone ?? Infinity) - (b.s.notDone ?? Infinity) || (b.s.f2p ?? -1) - (a.s.f2p ?? -1);

export function renderPlanReport({ meta, results }) {
  const out = ['# Form planner bench', '', `- pass: plan; provider ${meta.provider}; judge \`${meta.judgeModel}\` via ${meta.judgeProvider ?? meta.provider} (effort ${meta.judgeEffort ?? 'default'}); started ${meta.startedAt}`];
  out.push('- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.');
  out.push('- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.', '');
  out.push('## By model', '', table(['model', 'runs', 'scored', 'judge errors', 'no draft', 'timeouts', 'errors', 'notDone', 'unrequested', 'f2p coverage', 'static defect rate', 'planner tokens (reported)', 'judge tokens (reported)'],
    byModel(results).map(({ model, s }) => [model, s.total, s.scored, s.judgeErrors, s.noDraft, s.timeouts, s.errors, num(s.notDone), num(s.unrequested), pct(s.f2p), pct(s.defectRate), s.plannerTokens ?? 'n/a', s.judgeTokens ?? 'n/a'])), '');
  out.push('## Per case', '', table(['case', 'model', 'status', 'drafts', 'notDone', 'unrequested', 'f2p', 'static defects'],
    results.map((r) => {
      const j = r.judge;
      return [cell(r.caseId), r.model, r.error ? `${r.status}: ${cell(r.error)}` : r.status, (r.drafts ?? []).length,
        j?.ok ? j.notDone.map((x) => cell(x.item)).join('<br>') || '0' : j ? j.error : '', j?.ok ? j.unrequested.map((x) => cell(x.change)).join('<br>') || '0' : '',
        j?.ok ? j.f2pCoverage.map((c) => c.coverage).join(', ') || 'none listed' : '', (r.defects ?? []).map((d) => `${d.kind}: ${cell(d.item)}`).join('<br>') || 'none'];
    })), '');
  return out.join('\n');
}

export function renderPlanRatings({ meta, results }) {
  const rows = byModel(results).sort(rank).map(({ model, s }, i) => [i + 1, `**${model}**`, `\`${meta.provider}\``, num(s.notDone), num(s.unrequested), pct(s.f2p), pct(s.defectRate), s.timeouts + s.errors, s.noDraft, `${s.scored}/${s.total}`]);
  return ['# Planner Model Ratings (`eval:form --pass plan`)', '',
    `Judge \`${meta.judgeModel}\` (blind, one judge for all rows); run ${meta.startedAt}. Lower notDone and unrequested are better; higher f2p coverage is better.`, '',
    table(['Rank', 'Model', 'Provider / CLI', 'notDone / case', 'Unrequested / case', 'F2P coverage', 'Static defect rate', 'Timeouts + errors', 'No draft', 'Scored'], rows), ''].join('\n');
}
