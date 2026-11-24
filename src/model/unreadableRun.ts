/**
 * "This run produced no readable answer" — one reading for every surface
 * (UI-R14, arch:REVIEW R6b).
 *
 * An unreadable answer BLOCKS; it is not a failure and it is not a finding.
 * The Tester records it as `unreadable-output`. A Review run recorded before
 * that kind existed stored it as `execution-failed` with the aggregate's own
 * sentence in `failureDetail` ("unreadable output from <repo> ..."), so a
 * stored legacy row reads the same way.
 *
 * A crash or a usage limit stays `execution-failed` and reads as failed.
 */
export const UNREADABLE_RESULT_KIND = 'unreadable-output';

/** The legacy Review detail that marks an unreadable-only answer: a PREFIX, with the aggregate's own lead-in allowed. */
const LEGACY_UNREADABLE_DETAIL = /^(?:review findings: )?unreadable output from/;

/** Whether a process run produced no readable answer, by kind or by legacy row. */
export function isUnreadableRun(run: {
  readonly resultKind: string | null;
  readonly failureDetail?: string | null;
}): boolean {
  if (run.resultKind === UNREADABLE_RESULT_KIND) return true;
  return (
    run.resultKind === 'execution-failed' &&
    LEGACY_UNREADABLE_DETAIL.test((run.failureDetail ?? '').trimStart())
  );
}
