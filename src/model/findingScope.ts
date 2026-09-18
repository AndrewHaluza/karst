import type { ProcessRun } from '../store/processRuns.js';
import type { Finding } from '../store/reviewFindings.js';
import type { UatFinding } from '../store/uatFindings.js';

/**
 * Which findings a rendered surface may attribute to a stage's CURRENT run.
 *
 * Findings are append-only with no resolve path, and a clean re-review records
 * NO batch at all (`workflow/gates/evidence.ts` returns early on zero
 * findings). A greatest-`runAt` reduction over the whole ticket therefore
 * re-surfaces the previous round's batch forever — it is never superseded by an
 * empty one that was never written. Every rendered surface keys to the process
 * run instead, so a round that is still in flight renders nothing.
 *
 * This module is the ONE place that rule lives. Three surfaces consume it (the
 * inside Review row, and the Artifacts UAT and Review cards); they disagreed
 * before precisely because each answered the question itself.
 *
 * This is the findings-vs-RUN layer only. The layer above it — run-vs-
 * INVOCATION, i.e. whether the process run this module scopes by even belongs
 * to the stage's current entry — lives in `inside/currentAttempt.ts`; that
 * module's `null` (the re-entry window) is a fact this one does not know
 * about.
 *
 * The Artifacts UAT/Review cards read this module's scoping (by process run)
 * but NOT `currentAttempt.ts`'s invocation layer, and that asymmetry is
 * intentional: those cards are `v<n>`-labelled REPORTS of what a past run
 * produced, not a live ledger, so continuing to show the previous round's
 * findings during a re-entry window (before the new invocation's tester/review
 * process run exists) is the correct reading, not staleness.
 *
 * Deliberately NOT a consumer: the ship stage's findings row
 * (`ui/dashboard/state.ts`), which scopes by the review stage's `attempt` under
 * its own recorded ruling, and the fix-brief readers
 * (`extension.ts`, `context/ticketContext.ts`, `cli/fixBriefCommand.ts`),
 * which legitimately want the batch being fixed.
 */

/**
 * The pre-attribution findings, reduced to their newest batch.
 *
 * `review_findings.process_run_id` arrived in v27 and is NEVER backfilled
 * (`store/schema.sql`), and `ON DELETE SET NULL` strips it from a finding whose
 * run row is deleted. Those rows can only ever be reduced by `runAt`. An
 * ATTRIBUTED finding is never eligible here: it belongs to a run, and if that
 * run is not the latest it is not current.
 */
function legacyBatch(findings: readonly Finding[]): Finding[] {
  const legacy = findings.filter((f) => f.processRunId === null);
  const latest = legacy.reduce<string | null>(
    (max, f) => (max === null || f.runAt > max ? f.runAt : max),
    null,
  );
  return latest === null ? [] : legacy.filter((f) => f.runAt === latest);
}

/**
 * The review findings a surface may render for `run` — the stage's latest
 * review process run, or `undefined` when none is on record.
 *
 * Order is input order (report order), preserved.
 */
export function scopeReviewFindings(
  findings: readonly Finding[],
  run: ProcessRun | undefined,
): Finding[] {
  if (run === undefined) return legacyBatch(findings);
  const own = findings.filter((f) => f.processRunId === run.id);
  if (own.length > 0) return own;
  // In flight and nothing recorded yet: the round has produced no findings, and
  // the previous round's are not this round's. THIS is the case that used to
  // re-render a fixed batch under a running re-review.
  if (run.endedAt === null) return [];
  // Finished having recorded nothing of its own: only unattributed rows remain
  // eligible. On a v27+ ticket that is the empty set, which is what a clean
  // re-review must render.
  return legacyBatch(findings);
}

/**
 * The UAT observations a surface may render for `run` — the stage's latest
 * tester process run, or `undefined` when none is on record.
 *
 * `uat_findings.process_run_id` is NOT NULL (`store/schema.sql`), so there is
 * no legacy pool and no fallback: no run means nothing to attribute.
 *
 * Order is input order, preserved.
 */
export function scopeUatFindings(
  findings: readonly UatFinding[],
  run: ProcessRun | undefined,
): UatFinding[] {
  return run === undefined ? [] : findings.filter((f) => f.processRunId === run.id);
}
