/**
 * Host-side graph-recovery wiring — vscode-free, kept out of `extension.ts`
 * (the ratchet treats `extension.ts` as thin bindings only).
 *
 * The replan budget the coordinator seam derives from a run's accepted replan
 * count, and the refusal copy the Resume/Replan controls show the user.
 */

import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import { graphRunStatusReplanCount } from '../../store/graph/graphRuns.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import type { CompileContext } from '../../approaches/graph/compile.js';
import type { RecoveryRefusalReason } from '../../approaches/graph/coordinator/recovery.js';
import { formatId } from '../../model/entityId.js';

/** The project's hard replan cap: `limits.maxReplans`, with the packaged
 *  default fallback. Raising config can lift it; it is never the revision
 *  document's frozen `budgets.maxReplans`. */
export function projectMaxReplans(configured: number | undefined): number {
  return configured ?? DEFAULT_GRAPH_LIMITS.maxReplans;
}

/** The expert-spend counters for a graph compile. The reserve is the run's
 *  remaining project replan headroom (`projectMax - accepted replans`), so a
 *  human-bypass revision — whose run may already have spent at or beyond the
 *  document's declared maximum — reserves 0 instead of over-reserving. It is
 *  clamped at zero, so a spent run never yields a negative reserve.
 *
 *  `spentPlannerRuns` is every planner run the run has ALREADY performed: the
 *  bootstrap plus each accepted replan (a replan's planner run is allocated at
 *  election, before it compiles the new revision). Charging them here — rather
 *  than dropping them when the reserve shrinks — is what keeps the compile's
 *  `maxExpertRuns` ceiling honest: a revision that changes nothing may not
 *  quietly discharge replans the run already spent. */
export function compileExpertSpend(
  configuredMaxReplans: number | undefined,
  db: GraphDb | undefined,
  graphRunId: number,
): CompileContext['expertSpend'] {
  const replanCount = db ? (graphRunStatusReplanCount(db, graphRunId)?.replan_count ?? 0) : 0;
  return {
    spentPlannerRuns: 1 + replanCount,
    permittedReplans: Math.max(0, projectMaxReplans(configuredMaxReplans) - replanCount),
    bootstrapUnspent: false,
  };
}

/**
 * The human-facing graph-recovery refusal notice.
 *
 * `recoverGraphRun` emits its actionable guidance through the debug-only
 * `emitGraphDiagnostic` (a no-op unless the manifest turns debug on), so with
 * debug off the user saw only the bare refusal reason and no next step. This
 * composes the SAME guidance into the message the Resume/Replan controls
 * actually show — in every configuration, not just debug.
 */
export function graphRecoveryRefusalNotice(
  ticketId: number,
  mode: 'resume' | 'replan',
  reason: RecoveryRefusalReason,
): string {
  const head = `Ticket ${formatId('ticket', ticketId)}: the implementation graph cannot ${mode} itself (${reason}).`;
  switch (reason) {
    case 'config-then-resume':
      return (
        `${head} Replan bypasses the revision document's frozen replan budget. ` +
        `Raise limits.maxReplans (up to its maximum) and click Replan — if it is ` +
        `already at the maximum, no further replans are possible.`
      );
    case 'explicit-resolution':
      return `${head} Correct the flagged artifacts or claims — or Replan — then Resume.`;
    case 'discard-required':
      return `${head} Discard the unknown process, then Resume.`;
  }
}
