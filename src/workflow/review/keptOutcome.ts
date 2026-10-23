import type { KeptTarget } from '../usageLimitKept.js';

/** A sibling target's status carried on a Review park row's `keptOutcome`. */
export interface ReviewKeptTarget extends KeptTarget {
  findings?: number;
}

export function parseReviewKeptOutcome(raw: string | null): {
  findings: number;
  targets: ReviewKeptTarget[];
} {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      findings: typeof parsed?.findings === 'number' ? parsed.findings : 0,
      targets: Array.isArray(parsed?.targets)
        ? parsed.targets.filter(
            (t: unknown): t is ReviewKeptTarget =>
              !!t && typeof t === 'object' && typeof (t as { repo?: unknown }).repo === 'string',
          )
        : [],
    };
  } catch {
    return { findings: 0, targets: [] };
  }
}

/**
 * Carry the earlier park's sibling TARGETS forward when a review re-run parks
 * again. The fresh lane names only the target it touched; without this merge a
 * second quota stop would forget a partner target's `unreadable`/`ok` status,
 * which the next re-run's R6b ratio depends on. Findings themselves are already
 * durable in `review_findings`; this is the status/count half.
 */
export function mergeReviewKeptOutcome(fresh: string, prior: string | null): string {
  const freshParsed = parseReviewKeptOutcome(fresh);
  const priorParsed = parseReviewKeptOutcome(prior);
  const freshRepos = new Set(freshParsed.targets.map((t) => t.repo));
  const preserved = priorParsed.targets.filter((t) => !freshRepos.has(t.repo));
  const preservedFindings = preserved.reduce(
    (n, t) => n + (typeof t.findings === 'number' ? t.findings : 0),
    0,
  );
  return JSON.stringify({
    findings: preservedFindings + freshParsed.findings,
    targets: [...preserved, ...freshParsed.targets],
  });
}
