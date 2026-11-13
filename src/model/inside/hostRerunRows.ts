import type { GateRun } from '../../store/gateRuns.js';
import type { StageKey } from '../types.js';
import { formatDuration, formatExactDuration, formatTime, type EvidenceRow } from './types.js';

/** The most host re-run rows one gates list shows: the newest ones. */
export const HOST_RERUN_ROWS_LIMIT = 6;

const stripRepoDecoration = (name: string): string => name.replace(/\s+\([^)]*\)$/, '');

/**
 * The gate list rows of the host gate re-run (@arch:AC-45). The rows come after the recorded batch
 * and never change its count or its verdict: a re-run row is a fact about a later run, not a batch result.
 */
export function hostRerunRows(
  runs: readonly GateRun[],
  stageKey: StageKey,
  repoLabel: (repo: string) => string,
): EvidenceRow[] {
  return runs
    .filter((r) => r.stageKey === stageKey)
    .slice(-HOST_RERUN_ROWS_LIMIT)
    .map((r): EvidenceRow => ({
      status: r.exitCode === null ? 'note' : r.exitCode === 0 ? 'pass' : 'fail',
      label: stripRepoDecoration(r.gateName),
      detail: r.exitCode === null ? 'host re-run · did not run' : `host re-run · exit ${r.exitCode}`,
      duration: formatDuration(r.startedAt, r.endedAt),
      ...(r.repo ? { repo: repoLabel(r.repo) } : {}),
      ...(formatExactDuration(r.startedAt, r.endedAt) ? { durationExact: formatExactDuration(r.startedAt, r.endedAt) } : {}),
      ...(r.startedAt ? { time: formatTime(r.startedAt) } : {}),
    }));
}
