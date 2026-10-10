import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { getTicket } from '../../store/tickets.js';
import { clearStageBlock, stageBlock } from '../../store/stageBlocks.js';
import { latestStageRun } from '../../store/stageRuns.js';
import { recordBaselineDecisions, latestBaselineDecisions } from '../../store/baselineDecisions.js';
import { baselineState, type BaselineEntry } from '../../workflow/gates/baselineReview.js';
import { commitGateOutcome } from '../../workflow/gates/commit.js';
import { capForGate } from '../../workflow/fixAttempts.js';
import { nowIso } from '../../model/time.js';
import { formatId } from '../../model/entityId.js';
import { deriveBaselineEntries } from '../../workflow/gates/baselineReviewTicket.js';
import type { Notify } from './notify.js';

/**
 * The user's Approve / Reject on changed baselines (@arch:BASELINE-REVIEW).
 *
 * The webview names only entry INDICES; the host re-derives the entries itself
 * and resolves every index against them, so a stale or forged message can never
 * approve anything the host does not currently see as changed. All decisions of
 * one request land in one transaction, or none do.
 */

/** Longest rejection reason kept — it lands in the fix agent's prompt. */
export const BASELINE_REASON_MAX = 1000;

export type BaselineDecisionRequest =
  | { kind: 'approve'; indices: readonly number[] }
  | { kind: 'reject'; index: number; reason: string };

export type BaselineDecisionResult =
  | { kind: 'refused'; reason: string }
  /** Decisions stored; entries still await the user. */
  | { kind: 'pending'; remaining: number }
  /** Every entry approved: the block is cleared and UAT should run again. */
  | { kind: 'approved' }
  /** A rejection failed UAT into fix. */
  | { kind: 'rejected' };

export interface BaselineDecisionDeps {
  store: Store;
  manifest: Manifest | undefined;
  /** The ticket the panel owns — the message's own ticket is never consulted. */
  ticketId: number;
  /** Re-derives the changed entries, in the order the webview was shown. */
  deriveEntries: (ticketId: number) => Promise<BaselineEntry[]>;
  /** Kick the driver after a state change (the same trigger Resume uses). */
  redrive: (ticketId: number) => void;
  notify: Notify;
  now?: () => string;
  debug?: (message: string) => void;
}

function refuse(deps: BaselineDecisionDeps, reason: string): BaselineDecisionResult {
  deps.debug?.(`[gate] baseline decision ticket ${deps.ticketId}: refused (${reason})`);
  deps.notify.warn(reason);
  return { kind: 'refused', reason };
}

function validIndices(request: BaselineDecisionRequest, count: number): number[] | null {
  const indices = request.kind === 'approve' ? [...request.indices] : [request.index];
  if (indices.length === 0) return null;
  const ok = indices.every((i) => Number.isInteger(i) && i >= 0 && i < count);
  return ok ? [...new Set(indices)] : null;
}

/** One line per rejected entry — the failed verdict's reason, read by the fix agent. */
function rejectionReason(rejected: ReadonlyArray<{ path: string; reason: string }>): string {
  return rejected.map((r) => `Visual baseline rejected: ${r.path}: ${r.reason}`).join('\n');
}

export async function decideBaselines(
  deps: BaselineDecisionDeps,
  request: BaselineDecisionRequest,
): Promise<BaselineDecisionResult> {
  const { store, ticketId } = deps;
  const now = deps.now ?? nowIso;
  const label = formatId('ticket', ticketId);
  deps.debug?.(`[gate] baseline decision ticket ${ticketId}: ${request.kind}`);

  if (getTicket(store, ticketId).stageCurrent !== 'uat' || stageBlock(store, ticketId, 'uat')?.kind !== 'baseline-review') {
    return refuse(deps, `${label} is no longer waiting for a baseline review.`);
  }
  if (request.kind === 'reject' && request.reason.trim() === '') {
    return refuse(deps, 'Say why the baseline is wrong — the fix agent reads the reason.');
  }

  let entries: BaselineEntry[];
  try {
    entries = await deps.deriveEntries(ticketId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.debug?.(`[gate] baseline decision ticket ${ticketId}: could not derive entries (${message})`);
    await deps.notify.error(`Cannot read the changed baselines for ${label}: ${message}`);
    return { kind: 'refused', reason: message };
  }
  const indices = validIndices(request, entries.length);
  if (indices === null) {
    return refuse(deps, `The changed baselines of ${label} moved on — reopen the UAT report.`);
  }

  const reason = request.kind === 'reject' ? request.reason.trim().slice(0, BASELINE_REASON_MAX) : null;
  recordBaselineDecisions(
    store,
    ticketId,
    indices.map((i) => ({
      repo: entries[i]!.repo,
      path: entries[i]!.path,
      sha256: entries[i]!.newSha256,
      decision: request.kind === 'approve' ? ('approved' as const) : ('rejected' as const),
      reason,
    })),
    now(),
  );

  const latest = latestBaselineDecisions(store, ticketId);
  const states = entries.map((entry) => ({ entry, state: baselineState(entry, latest) }));
  const rejected = states.flatMap(({ entry, state }) =>
    state.kind === 'rejected' ? [{ path: entry.path, reason: state.reason }] : [],
  );
  if (rejected.length > 0) return failUat(deps, rejected, now);

  const remaining = states.filter(({ state }) => state.kind === 'pending').length;
  if (remaining > 0) {
    deps.debug?.(`[gate] baseline decision ticket ${ticketId}: ${remaining} still pending`);
    return { kind: 'pending', remaining };
  }
  clearStageBlock(store, ticketId, 'uat');
  deps.debug?.(`[gate] baseline decision ticket ${ticketId}: all approved — re-driving uat`);
  deps.redrive(ticketId);
  return { kind: 'approved' };
}

/**
 * Reject → a FAILED UAT verdict, through the same writer every gate failure
 * uses, so the attempt, the recovery round and the fix prompt all behave as for
 * a red gate. The earlier gate evidence stays untouched (@arch:RESULTS).
 */
function failUat(
  deps: BaselineDecisionDeps,
  rejected: ReadonlyArray<{ path: string; reason: string }>,
  now: () => string,
): BaselineDecisionResult {
  const { store, ticketId } = deps;
  const run = latestStageRun(store, ticketId, 'uat');
  const stage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'uat');
  const detail = rejectionReason(rejected);
  if (!run) return refuse(deps, `${formatId('ticket', ticketId)} has no UAT run to fail.`);
  commitGateOutcome(store, {
    ticketId,
    stageKey: 'uat',
    runAt: now(),
    artifactPath: stage?.artifactPath ?? '',
    gates: [],
    outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: detail } },
    recoveryTrigger: {
      sourceProcessId: 'gates',
      sourceStageRunId: run.id,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: detail,
      maxRounds: capForGate('uat', deps.manifest?.uat?.maxFixAttempts, deps.manifest?.review?.maxFixAttempts),
    },
    now,
    debug: deps.debug,
  });
  deps.debug?.(`[gate] baseline decision ticket ${ticketId}: ${rejected.length} rejected → uat failed, fix`);
  deps.redrive(ticketId);
  return { kind: 'rejected' };
}

/** The block these decisions answer (the `BlockerKind`). */
const BASELINE_BLOCK_ID = 'baseline-review';

export interface BaselineActionsDeps {
  store: Store;
  manifest: () => Manifest | undefined;
  ticketId: number;
  notify: Notify;
  /** Drive the ticket (the trigger Resume uses) after approve-all or a rejection. */
  redrive: (ticketId: number) => void;
  /** Repaint the panel after any decision, including a partial one. */
  refresh: (ticketId: number) => void;
  debug?: (message: string) => void;
  /** Test seam; defaults to real git detection. */
  deriveEntries?: (ticketId: number) => Promise<BaselineEntry[]>;
}

/**
 * The two dashboard actions, ready to spread into `DashboardActions`. The
 * block id is checked here (only `baseline-review` is decidable); every other
 * check lives in `decideBaselines`.
 */
export function makeBaselineActions(deps: BaselineActionsDeps): {
  baselineApprove: (blockId: string, indices: number[]) => Promise<void>;
  baselineReject: (blockId: string, index: number, reason: string) => Promise<void>;
} {
  const run = async (blockId: string, request: BaselineDecisionRequest): Promise<void> => {
    if (blockId !== BASELINE_BLOCK_ID) return;
    const manifest = deps.manifest();
    await decideBaselines(
      {
        store: deps.store,
        manifest,
        ticketId: deps.ticketId,
        notify: deps.notify,
        redrive: deps.redrive,
        debug: deps.debug,
        deriveEntries:
          deps.deriveEntries ?? ((ticketId) => deriveBaselineEntries({ store: deps.store, manifest }, ticketId)),
      },
      request,
    );
    deps.refresh(deps.ticketId);
  };
  return {
    baselineApprove: (blockId, indices) => run(blockId, { kind: 'approve', indices }),
    baselineReject: (blockId, index, reason) => run(blockId, { kind: 'reject', index, reason }),
  };
}
