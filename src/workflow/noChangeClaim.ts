/**
 * The no-change claim: when the fix agent made no code change, the next review
 * or tester run shows each open blocking item with the agent reason.
 */
import { isCoverageRecord } from '../model/coverageRecord.js';
import { isBlockingSeverity } from '../model/severityOrder.js';
import { REVIEW_FINDINGS_DEFAULTS, UAT_TESTER_BLOCKING_SEVERITY } from '../manifest/qualityDefaults.js';
import type { Severity } from '../manifest/types.js';
import type { Store } from '../store/db.js';
import { activeRoundAnyStage } from '../store/recoveryRoundsRead.js';
import { latestReviewBatch } from '../store/stallNote.js';
import { listUatFindings } from '../store/uatFindings.js';
import { blockingObservationLines } from './uat/tester.js';
import type { NoChangeClaim } from './noChangeClaimText.js';

export { NO_CHANGE_EVIDENCE_RULE, renderNoChangeClaim, type NoChangeClaim } from './noChangeClaimText.js';

type SourceStage = 'uat' | 'review';

const location = (file: string | null | undefined, line: number | null | undefined): string => {
  if (!file) return '';
  return line ? ` (${file}:${line})` : ` (${file})`;
};

/**
 * One `[sev] title (file:line)` line per open blocking item: the blocking review
 * findings of the latest batch, or the blocking observations of the latest
 * tester run. `blockingSeverity` is the manifest threshold; absent, the default.
 */
export function openBlockingItems(
  store: Store,
  ticketId: number,
  sourceStage: SourceStage,
  blockingSeverity?: Severity | 'none',
): string[] {
  if (sourceStage === 'review') {
    const threshold = blockingSeverity ?? REVIEW_FINDINGS_DEFAULTS.blockingSeverity;
    return latestReviewBatch(store, ticketId)
      .filter((f) => !isCoverageRecord(f) && isBlockingSeverity(f.severity, threshold))
      .map((f) => `[${f.severity}] ${f.title}${location(f.file, f.line)}`);
  }
  const all = listUatFindings(store, ticketId);
  const latestRun = all.reduce((max, f) => Math.max(max, f.processRunId), -1);
  const lines = blockingObservationLines(
    all.filter((f) => f.processRunId === latestRun),
    blockingSeverity ?? UAT_TESTER_BLOCKING_SEVERITY,
  );
  return lines.map((l) => l.replace(/^- /u, ''));
}

/**
 * The claim for a run of `sourceStage`, or null. It exists only when the
 * revalidating round has this source stage and a stored no-change reason.
 */
export function noChangeClaimFor(
  store: Store,
  ticketId: number,
  sourceStage: SourceStage,
  blockingSeverity?: Severity | 'none',
): NoChangeClaim | null {
  const round = activeRoundAnyStage(store, ticketId);
  if (round === null || round.sourceStage !== sourceStage || round.noChangeReason === null) return null;
  return { reason: round.noChangeReason, items: openBlockingItems(store, ticketId, sourceStage, blockingSeverity) };
}
