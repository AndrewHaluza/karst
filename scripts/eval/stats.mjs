// Aggregation for the eval report. Pure functions over per-attempt records:
//   {instanceId, variant, run, scoring, end, blockedKind, resolved, metrics?}
// scoring: 'scored' | 'excluded'. Only 'scored' attempts enter the resolved rate; an excluded attempt
// (setup-failed, harness error) is counted by kind, never as an agent failure.
// end: how the run ended (evalPolicy.classifyEnd): terminal | blocked | timeout | failed | incomplete.
// Every attempt with an end other than 'terminal' is also counted by kind, apart from test failure.

export const LOW_CONFIDENCE_N = 3;

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Unbiased pass@k (Chen et al.): 1 - C(n-c, k) / C(n, k). null when n < k. */
export function passAtK(n, c, k) {
  if (n < k) return null;
  if (n - c < k) return 1;
  let p = 1;
  for (let i = n - c + 1; i <= n; i++) p *= 1 - k / i;
  return 1 - p;
}

/** Per-variant summary over attempts. */
export function summarizeVariant(attempts, { kValues = [1, 3] } = {}) {
  const scored = attempts.filter((a) => a.scoring === 'scored');
  const byRun = new Map();
  for (const a of scored) {
    const r = byRun.get(a.run) ?? { n: 0, c: 0 };
    r.n += 1;
    r.c += a.resolved ? 1 : 0;
    byRun.set(a.run, r);
  }
  const runRates = [...byRun.values()].map((r) => r.c / r.n);
  const byInstance = new Map();
  for (const a of scored) {
    const r = byInstance.get(a.instanceId) ?? { n: 0, c: 0 };
    r.n += 1;
    r.c += a.resolved ? 1 : 0;
    byInstance.set(a.instanceId, r);
  }
  const resolved = scored.filter((a) => a.resolved).length;
  const passAt = {};
  for (const k of kValues) {
    const per = [...byInstance.values()].map((r) => passAtK(r.n, r.c, k)).filter((v) => v !== null);
    passAt[k] = per.length === 0 ? null : mean(per);
  }
  const ends = {};
  for (const a of attempts) {
    if (a.end === 'terminal' && a.scoring === 'scored') continue;
    const end = a.scoring === 'excluded' && a.end === 'terminal' ? 'excluded' : a.end;
    const key = a.blockedKind ? `${end}:${a.blockedKind}` : end;
    ends[key] = (ends[key] ?? 0) + 1;
  }
  return {
    attempts: attempts.length,
    scored: scored.length,
    resolved,
    resolvedRate: scored.length === 0 ? null : resolved / scored.length,
    // Spread across runs (sample sd of the per-run rate); null with a single run.
    spread: sd(runRates),
    runs: byRun.size,
    passAt,
    lowConfidence: scored.length < LOW_CONFIDENCE_N,
    ends,
  };
}

/**
 * Pairwise delta of resolved rate on the instances both variants scored. Comparing on the shared
 * instances keeps a variant that blocked on hard tasks from looking better than it is.
 */
export function pairwiseDeltas(attemptsByVariant) {
  const names = Object.keys(attemptsByVariant);
  const rate = (as, ids) => {
    const xs = as.filter((a) => a.scoring === 'scored' && ids.has(a.instanceId));
    return xs.length === 0 ? null : xs.filter((a) => a.resolved).length / xs.length;
  };
  const scoredIds = (as) => new Set(as.filter((a) => a.scoring === 'scored').map((a) => a.instanceId));
  const out = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = attemptsByVariant[names[i]];
      const b = attemptsByVariant[names[j]];
      const shared = new Set([...scoredIds(a)].filter((id) => scoredIds(b).has(id)));
      const ra = rate(a, shared);
      const rb = rate(b, shared);
      out.push({ a: names[i], b: names[j], sharedInstances: shared.size, delta: ra === null || rb === null ? null : rb - ra, lowConfidence: shared.size < LOW_CONFIDENCE_N });
    }
  }
  return out;
}

/** Sum of a metric over attempts; null ('pending') if ANY attempt lacks it, never a silent 0. */
export function sumOrPending(attempts, pick) {
  let total = 0;
  for (const a of attempts) {
    const v = pick(a);
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
}

/** Cost or time per resolved task: total over ALL attempts (failures cost too) divided by resolved count. */
export function perResolved(attempts, pick) {
  const resolved = attempts.filter((a) => a.scoring === 'scored' && a.resolved).length;
  const total = sumOrPending(attempts, pick);
  if (resolved === 0 || total === null) return null;
  return total / resolved;
}
