// eval-results/<ts>/report.md: harness results merged with karst metrics.
import { pairwiseDeltas, perResolved, summarizeVariant } from './stats.mjs';

const pct = (v) => (v === null || v === undefined ? 'pending' : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 1) => (v === null || v === undefined ? 'pending' : v.toFixed(d));
const secs = (v) => (v === null || v === undefined ? 'pending' : `${Math.round(v)}s`);

function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * meta: {setName, setVersion, cores: [{core, version}], variants: string[], runs, startedAt, excluded: [ids]}
 * attempts: [{instanceId, variant, run, scoring, end, resolved, blockedKind, stage, reason, metrics}]
 */
export function renderReport({ meta, attempts }) {
  const byVariant = Object.fromEntries(meta.variants.map((v) => [v, attempts.filter((a) => a.variant === v)]));
  const summaries = Object.fromEntries(meta.variants.map((v) => [v, summarizeVariant(byVariant[v])]));
  const out = [];
  out.push('# Eval report', '');
  out.push(`- instance set: \`${meta.setName}\` version \`${meta.setVersion}\` (compare results only within one version)`);
  out.push(`- cores: ${meta.cores.length === 0 ? 'pending' : meta.cores.map((c) => `${c.core} ${c.version}`).join(', ')}`);
  out.push(`- variants: ${meta.variants.join(', ')}; runs per instance: ${meta.runs}; started ${meta.startedAt}`);
  if (meta.excluded?.length) out.push(`- excluded as drifted (gold patch not resolving): ${meta.excluded.join(', ')}`);
  out.push('', '## Resolved rate', '');
  out.push('Resolved = official harness verdict only (F2P flipped and P2P kept). Blocked and timed-out attempts are excluded from the rate and counted below.', '');
  out.push(table(
    ['variant', 'scored', 'resolved', 'rate', 'spread (sd over runs)', 'pass@1', 'pass@3', 'confidence'],
    meta.variants.map((v) => {
      const s = summaries[v];
      return [v, s.scored, s.resolved, pct(s.resolvedRate), s.spread === null ? 'n/a (1 run)' : pct(s.spread), pct(s.passAt[1]), pct(s.passAt[3]), s.lowConfidence ? 'LOW (n<3)' : 'ok'];
    }),
  ));
  const deltas = pairwiseDeltas(byVariant);
  if (deltas.length > 0) {
    out.push('', '## Pairwise deltas (B − A, resolved rate on shared scored instances)', '');
    out.push(table(['A', 'B', 'shared', 'delta', 'confidence'], deltas.map((d) => [d.a, d.b, d.sharedInstances, d.delta === null ? 'pending' : `${(d.delta * 100).toFixed(1)} pp`, d.lowConfidence ? 'LOW (n<3)' : 'ok'])));
  }
  out.push('', '## Cost and time per resolved task', '');
  out.push('Totals cover every attempt of the variant (failures cost too) divided by the resolved count. Dollar cost is pending: `token_usage` has no price column.', '');
  out.push(table(
    ['variant', 'wall / resolved', 'agent-active / resolved', 'reported tokens / resolved', 'estimated tokens / resolved'],
    meta.variants.map((v) => {
      const as = byVariant[v];
      return [
        v,
        secs(perResolved(as, (a) => a.metrics?.wallSeconds)),
        secs(perResolved(as, (a) => a.metrics?.agentActiveSeconds)),
        num(perResolved(as, (a) => a.metrics?.tokens?.reportedTokens), 0),
        num(perResolved(as, (a) => a.metrics?.tokens?.estimatedTokens), 0),
      ];
    }),
  ));
  out.push('', '## Blocked and timed-out runs', '');
  const ends = meta.variants.flatMap((v) => Object.entries(summaries[v].ends).map(([k, n]) => [v, k, n]));
  out.push(ends.length === 0 ? 'None.' : table(['variant', 'end (end:blockedKind)', 'count'], ends));
  out.push('', '## Per attempt', '');
  out.push(table(
    ['instance', 'variant', 'run', 'end', 'stage', 'resolved', 'rework', 'first-pass', 'review findings', 'wall'],
    attempts.map((a) => [
      a.instanceId, a.variant, a.run, a.blockedKind ? `${a.end}:${a.blockedKind}` : a.end, a.stage ?? 'pending',
      a.scoring === 'scored' ? String(Boolean(a.resolved)) : 'n/a',
      a.metrics?.reworkRounds ?? 'pending', pct(a.metrics?.firstPassRate), a.metrics?.reviewFindings ?? 'pending', secs(a.metrics?.wallSeconds),
    ]),
  ));
  const reasons = attempts.filter((a) => a.reason);
  if (reasons.length > 0) {
    out.push('', '### End reasons', '');
    for (const a of reasons) out.push(`- ${a.instanceId} / ${a.variant} / run ${a.run}: ${a.end}${a.blockedKind ? `:${a.blockedKind}` : ''} at ${a.stage} — ${a.reason}`);
  }
  out.push('');
  return out.join('\n');
}
