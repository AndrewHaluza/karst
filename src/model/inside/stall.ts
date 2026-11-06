import type { Severity } from '../../manifest/types.js';
import type { ReviewStallDetection } from '../../manifest/types.js';
import type { Finding } from '../../store/reviewFindings.js';
import { evaluateReviewStall, type StallAttempt } from '../reviewStall.js';
import type { ProcessRun } from '../../store/processRuns.js';
import { isBlockingSeverity } from '../severityOrder.js';

/** What the Inside review view shows about repeated blocking findings. */
export interface InsideStallView {
  /** True once the configured thresholds say the ticket parks as `review-stalled`. */
  stalled: boolean;
  /** Longest consecutive-round streak of any file. */
  rounds: number;
  files: readonly { file: string; roundsHit: number }[];
  /** Finding identities recurring across the latest two attempts. */
  repeatedIdentities: number;
}

/** Display threshold: a file or finding that has already repeated once is worth showing. */
const WATCH_ROUNDS = 2;

/**
 * Blocking findings per attempt, oldest first. A review process run that passed
 * under an attempt with no blocking finding is a clean round: an empty attempt
 * that breaks the streak, as the guard reads it.
 */
function attemptsOf(
  findings: readonly Finding[],
  threshold: Severity | 'none',
  processRuns: readonly ProcessRun[],
): StallAttempt[] {
  const byAttempt = new Map<number, Finding[]>();
  for (const f of findings) {
    if (!isBlockingSeverity(f.severity, threshold)) continue;
    byAttempt.set(f.attempt, [...(byAttempt.get(f.attempt) ?? []), f]);
  }
  const attempts: StallAttempt[] = [...byAttempt.entries()].map(([attempt, rows]) => ({
    attempt,
    findings: rows.map((r) => ({ file: r.file, line: r.line, identity: r.identity ?? null })),
  }));
  for (const p of processRuns) {
    if (p.stageKey === 'review' && p.processId === 'review' && p.status === 'passed' && !byAttempt.has(p.attempt)) {
      attempts.push({ attempt: p.attempt, findings: [] });
    }
  }
  return attempts.sort((a, b) => a.attempt - b.attempt);
}

/** Pure: the stall picture for the review findings, or `undefined` when there is nothing to show. */
export function stallView(
  findings: readonly Finding[],
  threshold: Severity | 'none',
  cfg: ReviewStallDetection,
  processRuns: readonly ProcessRun[] = [],
): InsideStallView | undefined {
  if (!cfg.enabled) return undefined;
  const attempts = attemptsOf(findings, threshold, processRuns);
  const watch = evaluateReviewStall(attempts, {
    enabled: true,
    sameFileRounds: WATCH_ROUNDS,
    repeatedFindingRounds: WATCH_ROUNDS,
  });
  if (watch === null) return undefined;
  return {
    stalled: evaluateReviewStall(attempts, cfg) !== null,
    rounds: watch.rounds,
    files: watch.files.map(({ file, roundsHit }) => ({ file, roundsHit })),
    repeatedIdentities: watch.repeatedIdentities,
  };
}
