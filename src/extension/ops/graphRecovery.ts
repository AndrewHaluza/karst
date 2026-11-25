/**
 * Host-side graph-recovery wiring — vscode-free, kept out of `extension.ts`
 * (the ratchet treats `extension.ts` as thin bindings only).
 *
 * The replan budget the coordinator seam derives from a run's accepted replan
 * count, and the refusal copy the Resume/Replan controls show the user.
 */

import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import {
  graphRunIdStatusBlockedReason,
  graphRunNodeRunCount,
  graphRunStatusReplanCount,
} from '../../store/graph/graphRuns.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import { getTicket } from '../../store/tickets.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { blockedGraphRunFor } from '../../workflow/graphMarkerGuard.js';
import type { CompileContext } from '../../approaches/graph/compile.js';
import { parkNodeLaunchExit, type GraphDriverDeps } from '../../approaches/graph/driver.js';
import type { LaunchFailure } from '../../approaches/graph/transport/supervisedCliTransport.js';
import {
  GRAPH_FAILED_BLOCKER,
  recoveryCategoryFor,
  type GraphRecoveryMode,
  type RecoveryRefusalReason,
  type RecoveryResult,
} from '../../approaches/graph/coordinator/recovery.js';
import {
  recoveryGuidance,
  type RecoveryGuidanceContext,
} from '../../approaches/graph/coordinator/recoveryGuidance.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './graphRecoveryDispatch.js';
import { formatId } from '../../model/entityId.js';

/**
 * The supervised transport's early-exit callback (T693): a provider that exited
 * before its session started parks the node `failed-to-launch` with the
 * captured line as its reason. The driver deps are read lazily — the callback
 * fires long after activation builds the transport.
 */
export function parkGraphLaunchFailure(
  deps: () => GraphDriverDeps,
  report: (message: string, err: unknown) => void,
): (failure: LaunchFailure) => void {
  return (failure) => {
    try {
      parkNodeLaunchExit(
        deps(),
        failure.request.graphRunId,
        failure.request.nodeRunId,
        failure.outputLine,
      );
    } catch (err) {
      report('karst: parking a failed graph launch failed', err);
    }
  };
}

/** What the Resume control shows after `recoverGraphRun` refused. */
export interface GraphRefusalHandling {
  message: string;
  /**
   * A plain Resume on a launch loop is refused — its only exit is the explicit
   * Force retry, which the host offers as a modal. Every other refusal is a
   * plain notice.
   */
  offerForce: boolean;
}

export function graphRefusalHandling(
  ticketId: number,
  mode: GraphRecoveryMode,
  reason: RecoveryRefusalReason,
  ctx?: RecoveryGuidanceContext,
): GraphRefusalHandling {
  const notice = graphRecoveryRefusalNotice(
    ticketId,
    mode === 'replan' ? 'replan' : 'resume',
    reason,
    ctx,
  );
  const offerForce = reason === 'launch-loop' && mode === 'resume';
  // The Force mention rides ONLY where the button does — the modal. The plain
  // notice is shown by Resume routes that offer no Force, so promising one
  // there named a control that was not on screen.
  return {
    message: offerForce ? `${notice} Force a retry to launch it again anyway.` : notice,
    offerForce,
  };
}

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

/** Node runs the graph run already reserved, across every revision. */
export function compileSpentNodeRuns(db: GraphDb | undefined, graphRunId: number): number {
  return db ? graphRunNodeRunCount(db, graphRunId) : 0;
}

/**
 * The human-facing graph-recovery refusal notice.
 *
 * `recoverGraphRun` emits its actionable guidance through the debug-only
 * `emitGraphDiagnostic` (a no-op unless the manifest turns debug on), so with
 * debug off the user saw only the bare refusal reason and no next step. This
 * composes the SAME guidance into the message the Resume/Replan controls
 * actually show — in every configuration, not just debug.
 *
 * The guidance itself has ONE source (`recoveryGuidance`), shared with that
 * diagnostic; a pin test holds both to the same text so they cannot drift.
 * `ctx` is optional so a caller that has not read the run's replan counts still
 * compiles and still gets the truthful short fallback.
 */
export function graphRecoveryRefusalNotice(
  ticketId: number,
  mode: 'resume' | 'replan',
  reason: RecoveryRefusalReason,
  ctx?: RecoveryGuidanceContext,
): string {
  const head = `Ticket ${formatId('ticket', ticketId)}: the implementation graph cannot ${mode} itself (${reason}).`;
  return `${head} ${recoveryGuidance(reason, ctx)}`;
}

/**
 * The guidance context for one refused run: its recorded block reason, the
 * recovery category that reason maps to, and its accepted replan count against
 * the project's `limits.maxReplans` cap. Store reads only (no raw SQL) — the
 * same rows `recoverGraphRun` decides on. The category matters because one
 * refusal reason covers two exits: `explicit-resolution` is Replan-only for
 * the true category, but the artifact re-check, prompt re-snapshot and
 * planner relaunch refuse with it while Resume is what the banner offers.
 */
export function graphRefusalContext(
  db: GraphDb,
  graphRunId: number,
  cap: number,
): RecoveryGuidanceContext {
  const run = graphRunIdStatusBlockedReason(db, graphRunId);
  const count = graphRunStatusReplanCount(db, graphRunId);
  return {
    blockedReason: run?.blocked_reason ?? null,
    recoveryCategory: recoveryCategoryFor(run?.blocked_reason ?? null),
    replanCount: count?.replan_count ?? 0,
    projectMaxReplans: cap,
  };
}

/** The host-side stage Replan control's deps. `dashboardActions.ts` stays a
 *  thin binding over this (vscode-free, so the guards below are unit- and
 *  mutation-tested). */
export interface ReplanBlockedStageDeps {
  store: Store;
  /** The ticket this dashboard panel is pinned to. */
  panelTicketId: number;
  /** The ticket id the click message carried. */
  msgTicketId: number;
  /** The stage the banner is rendered for. */
  stageKey: StageKey;
  seams: GraphRecoverySeams;
  /** The project's `limits.maxReplans` for the run, read from the manifest. */
  projectMaxReplansOf: (graphRunId: number) => number | undefined;
  onRefused: (notice: string) => void;
}

/**
 * The blocked banner's primary Replan: recover the blocked graph run in
 * `replan` mode, and report a refusal through `onRefused` with the same
 * truthful guidance every other refusal surface shows.
 *
 * Every precondition that would make the click a lie is a `no-op`: a stale
 * panel, a stage that moved on, no graph block (or a different blocker kind),
 * or a block whose run is gone. The dispatch itself is shared with Resume, so
 * the launch and refresh follow-up cannot drift.
 */
export function replanBlockedStage(deps: ReplanBlockedStageDeps): RecoveryResult {
  if (deps.msgTicketId !== deps.panelTicketId) return { kind: 'no-op' };
  const ticket = getTicket(deps.store, deps.panelTicketId);
  if (ticket.stageCurrent !== deps.stageKey) return { kind: 'no-op' };
  const block = stageBlock(deps.store, deps.panelTicketId, deps.stageKey);
  if (!block || block.kind !== GRAPH_FAILED_BLOCKER) return { kind: 'no-op' };
  const graphRunId = blockedGraphRunFor(deps.store, deps.panelTicketId);
  if (graphRunId === undefined) return { kind: 'no-op' };
  const recovery = dispatchGraphRecovery(deps.seams, {
    ticketId: deps.panelTicketId,
    graphRunId,
    mode: 'replan',
  });
  if (recovery.kind === 'refused') {
    deps.onRefused(
      graphRecoveryRefusalNotice(
        deps.panelTicketId,
        'replan',
        recovery.reason,
        graphRefusalContext(
          deps.store.db,
          graphRunId,
          projectMaxReplans(deps.projectMaxReplansOf(graphRunId)),
        ),
      ),
    );
  }
  return recovery;
}
