import type { Store } from '../../store/db.js';
import { listUatFindings, recordUatFindings, type UatFindingInput } from '../../store/uatFindings.js';
import { countBlockingObservations, type TesterRunResult } from './tester.js';
import { uatObservationKey } from './keptOutcome.js';

/**
 * The blocking count a usage-limit re-run decides on: the observations its
 * Tester just recorded PLUS the sibling observations the earlier park kept. The
 * verdict must not discard a blocking observation a partner target already
 * reported, even though no Tester asked it again.
 */
export function combinedBlocking(
  store: Store,
  ticketId: number,
  testerRunId: number | null,
  testerResult: TesterRunResult | null,
  siblings: readonly UatFindingInput[],
  blockingSeverity: Parameters<typeof countBlockingObservations>[1],
): { blocking: number; blockingSummary?: string } {
  const fresh =
    testerResult?.kind === 'observed' || testerResult?.kind === 'partial'
      ? listUatFindings(store, ticketId)
          .filter((f) => testerRunId !== null && f.processRunId === testerRunId)
          .map((f) => ({ severity: f.severity, repo: f.repo, file: f.filePath, line: f.line, title: f.title }))
      : [];
  return countBlockingObservations([...fresh, ...siblings], blockingSeverity);
}

/**
 * Persist the sibling observations under the re-run's Tester process run.
 *
 * They may exist ONLY on the park row: a Tester that died on quota returns
 * before its single `recordUatFindings` call, so nothing ever wrote them.
 * Counting them into the verdict without persisting leaves the fix session with
 * a reason that names evidence nobody can read. Deduped against what the ticket
 * already holds, so a chain of re-parks cannot duplicate a row.
 */
export function persistSiblingObservations(
  store: Store,
  ticketId: number,
  testerRunId: number | null,
  siblings: readonly UatFindingInput[],
  createdAt: string,
): void {
  if (testerRunId === null || siblings.length === 0) return;
  const known = new Set(
    listUatFindings(store, ticketId).map((f) =>
      uatObservationKey({ repo: f.repo, severity: f.severity, title: f.title, file: f.filePath, line: f.line }),
    ),
  );
  const missing = siblings.filter((o) => !known.has(uatObservationKey(o)));
  if (missing.length > 0) {
    recordUatFindings(store, { ticketId, processRunId: testerRunId, findings: missing, createdAt });
  }
}
