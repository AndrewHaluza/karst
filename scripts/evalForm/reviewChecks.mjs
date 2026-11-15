// Deterministic scoring of one review-findings run against the seeded defects of a case.
// Pure: no parse, no coverage split, no git. The runner owns those and passes final findings.
export const REVIEW_MATCH_WINDOW = 3;
const BLOCKING = new Set(['high', 'critical']);

const inWindow = (defect, line) => line >= defect.lineStart - REVIEW_MATCH_WINDOW && line <= defect.lineEnd + REVIEW_MATCH_WINDOW;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const rank = (severity) => SEVERITY_RANK[severity] ?? 0;
const hits = (defect, f) =>
  f.file === defect.file && Number.isInteger(f.line) && inWindow(defect, f.line) && rank(f.severity) >= rank(defect.minSeverity);
const distance = (defect, line) => (line < defect.lineStart ? defect.lineStart - line : Math.max(0, line - defect.lineEnd));

/**
 * One finding matches at most one defect and one defect matches at most one finding.
 * A finding takes the nearest defect whose window and minimum severity it meets. A tie goes to the first defect.
 * -> `{found, missed, falseFindings, duplicates, blockingFalse, caseFailed, parseTier, shape, droppedCheckoutClaims}`
 */
export function scoreReview({ defects, findings, tier, shape, droppedCheckoutClaims }) {
  const taken = new Set();
  const matched = new Set();
  findings.forEach((f, i) => {
    const near = defects.filter((x) => !taken.has(x.id) && hits(x, f));
    const d = near.reduce((best, x) => (best === undefined || distance(x, f.line) < distance(best, f.line) ? x : best), undefined);
    if (!d) return;
    taken.add(d.id);
    matched.add(i);
  });
  // A later finding on a defect that another finding already took is a duplicate, not a false finding.
  const isDuplicate = (f) => defects.some((d) => taken.has(d.id) && hits(d, f));
  const unmatched = findings.filter((_, i) => !matched.has(i));
  const duplicates = unmatched.filter(isDuplicate).length;
  const falses = unmatched.filter((f) => !isDuplicate(f));
  return {
    found: defects.filter((d) => taken.has(d.id)).map((d) => d.id),
    missed: defects.filter((d) => !taken.has(d.id)).map((d) => d.id),
    falseFindings: falses.length,
    duplicates,
    blockingFalse: falses.filter((f) => BLOCKING.has(f.severity)).length,
    caseFailed: defects.length === 0 && falses.length > 0,
    parseTier: tier,
    shape,
    droppedCheckoutClaims,
  };
}
