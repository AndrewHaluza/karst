// Deterministic scoring of one review-findings run against the seeded defects of a case.
// Pure: no parse, no coverage split, no git. The runner owns those and passes final findings.
export const REVIEW_MATCH_WINDOW = 3;
const BLOCKING = new Set(['high', 'critical']);

const inWindow = (defect, line) => line >= defect.lineStart - REVIEW_MATCH_WINDOW && line <= defect.lineEnd + REVIEW_MATCH_WINDOW;
const hits = (defect, f) => f.file === defect.file && Number.isInteger(f.line) && inWindow(defect, f.line);

/**
 * One finding matches at most one defect and one defect matches at most one finding.
 * The first match in output order wins.
 * -> `{found, missed, falseFindings, blockingFalse, caseFailed, parseTier, shape, droppedCheckoutClaims}`
 */
export function scoreReview({ defects, findings, tier, shape, droppedCheckoutClaims }) {
  const taken = new Set();
  const matched = new Set();
  findings.forEach((f, i) => {
    const d = defects.find((x) => !taken.has(x.id) && hits(x, f));
    if (!d) return;
    taken.add(d.id);
    matched.add(i);
  });
  const falses = findings.filter((_, i) => !matched.has(i));
  return {
    found: defects.filter((d) => taken.has(d.id)).map((d) => d.id),
    missed: defects.filter((d) => !taken.has(d.id)).map((d) => d.id),
    falseFindings: falses.length,
    blockingFalse: falses.filter((f) => BLOCKING.has(f.severity)).length,
    caseFailed: defects.length === 0 && falses.length > 0,
    parseTier: tier,
    shape,
    droppedCheckoutClaims,
  };
}
