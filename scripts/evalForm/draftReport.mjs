// Draft pass report: aggregates, core/model split, per-draft side-by-side with downstream outcome. No correlation claims.
import { DEFECT_KINDS } from './draftChecks.mjs';
import { cell } from './report.mjs';

export const LOW_N = 10;
const num = (v, d = 1) => (v === null || v === undefined ? 'pending' : Number(v).toFixed(d));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export const scored = (results) => results.filter((r) => r.judge?.ok);

export function summarizeDrafts(results) {
  const ok = scored(results);
  const checked = results.filter((r) => r.defects);
  const kindRate = Object.fromEntries(DEFECT_KINDS.map((k) => [k, checked.length === 0 ? null : checked.filter((r) => r.defects.some((d) => d.kind === k)).length / checked.length]));
  return {
    total: results.length,
    unavailable: results.filter((r) => r.unavailable).length,
    callErrors: results.filter((r) => r.error).length,
    judgeErrors: results.filter((r) => r.judge && !r.judge.ok).length,
    scored: ok.length,
    notDonePerDraft: mean(ok.map((r) => r.judge.notDone.length)),
    unrequestedPerDraft: mean(ok.map((r) => r.judge.unrequested.length)),
    reviewFixPerDraft: mean(ok.map((r) => r.judge.reviewFix.length)),
    defectRate: kindRate,
    truncated: checked.filter((r) => r.truncation?.wasTruncated).length,
  };
}

const outcomeCells = (o) => (o
  ? [o.reworkRounds, o.reviewFindings, o.fixRounds, o.medianHoursToMerge].map((v) => num(v))
  : ['pending', 'pending', 'pending', 'pending']);

export function renderDraftReport({ meta, results, outcomes }) {
  const out = ['# Form draft eval', ''];
  out.push(`- pass: draft; provider ${meta.provider}; judge \`${meta.judgeModel}\`; started ${meta.startedAt}`);
  out.push('- Ground truth is the landed diff (`git diff <merge_sha>^1 <merge_sha>`), never the PR description. Drafts are not replayed.');
  out.push('- Excluded and counted, never scored 0: `unavailable(...)`, call errors, judge-errors. `pending` = no source row. n < 10 is LOW: side-by-side only, no correlation claim.');
  out.push('- Outcome = `collectDraftOutcomes` (the same metric queries behind `karst stats --planning`), one draft-born ticket each; time to merge is median hours from proposal creation.', '');
  const s = summarizeDrafts(results);
  out.push('## Summary', '', table(['drafts', 'unavailable', 'call errors', 'judge errors', 'scored', 'notDone/draft', 'unrequested/draft', 'reviewFix/draft', 'truncated'],
    [[s.total, s.unavailable, s.callErrors, s.judgeErrors, s.scored, num(s.notDonePerDraft, 2), num(s.unrequestedPerDraft, 2), num(s.reviewFixPerDraft, 2), s.truncated]]), '');
  out.push('### Static defect rate by kind (share of checked drafts with at least one)', '', table(DEFECT_KINDS, [DEFECT_KINDS.map((k) => (s.defectRate[k] === null ? 'pending' : `${(s.defectRate[k] * 100).toFixed(0)}%`))]), '');
  const unavailable = [...new Set(results.filter((r) => r.unavailable).map((r) => r.unavailable))];
  if (unavailable.length) out.push(`Unavailable reasons: ${unavailable.map((u) => `unavailable(${u}) x${results.filter((r) => r.unavailable === u).length}`).join(', ')}`, '');
  const groups = new Map();
  for (const r of results) groups.set(`${r.core}/${r.model}`, [...(groups.get(`${r.core}/${r.model}`) ?? []), r]);
  out.push('## By planning core/model', '', table(['core/model', 'drafts', 'scored', 'notDone/draft', 'unrequested/draft', 'defects/draft', 'truncated', 'rework', 'review findings', 'fix rounds', 'h to merge (mean)'],
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => {
      const g = summarizeDrafts(rs);
      const os = rs.map((r) => outcomes.get(r.id)).filter(Boolean);
      const m = (key) => mean(os.map((o) => o[key]).filter((v) => typeof v === 'number'));
      const defects = mean(rs.filter((r) => r.defects).map((r) => r.defects.length));
      return [g.scored < LOW_N ? `${k} LOW` : k, rs.length, g.scored, num(g.notDonePerDraft, 2), num(g.unrequestedPerDraft, 2), num(defects, 2), g.truncated, num(m('reworkRounds')), num(m('reviewFindings')), num(m('fixRounds')), num(m('medianHoursToMerge'))];
    })), '');
  out.push('## Per draft', '', table(['draft', 'title', 'notDone', 'unrequested', 'static defects', 'diff', 'rework / findings / fix rounds / h to merge'],
    results.map((r) => {
      const title = cell(r.title);
      if (r.unavailable) return [`D${r.id}`, title, `unavailable(${r.unavailable})`, '', '', '', ''];
      if (r.error) return [`D${r.id}`, title, `error: ${cell(r.error)}`, '', '', '', ''];
      const defects = r.defects.map((d) => `${d.kind}: ${cell(d.item)}`).join('<br>') || 'none';
      const t = r.truncation;
      const diff = t?.wasTruncated ? `truncated (${t.dropped.length} dropped, ${t.truncated.length} cut)` : 'full';
      const oc = outcomeCells(outcomes.get(r.id)).join(' / ');
      if (!r.judge.ok) return [`D${r.id}`, title, r.judge.error, '', defects, diff, oc];
      return [`D${r.id}`, title, r.judge.notDone.map((x) => cell(x.item)).join('<br>') || '0', r.judge.unrequested.map((x) => `${cell(x.change)} (${cell(x.file ?? '')})`).join('<br>') || '0', defects, diff, oc];
    })), '');
  return out.join('\n');
}
