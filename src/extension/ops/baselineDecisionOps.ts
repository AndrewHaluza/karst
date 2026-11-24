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
import { hasLinkedPrototype, PROTOTYPE_REGION_CHECKLIST_RULE } from '../../agent/fixBrief.js';
import type { Notify } from './notify.js';

/**
 * The user's Approve / Reject / Send on changed baselines (@arch:BASELINE-REVIEW).
 *
 * A reject only RECORDS the decision: the ticket stays parked and the overlay
 * stays open, so the user can reject many entries. The rejected entries go to
 * fix in one round on Send, or by themselves when a decision leaves no entry
 * pending. The webview names only entry INDICES; the host re-derives the entries
 * itself and resolves every index against them, so a stale or forged message can
 * never approve anything the host does not currently see as changed. All
 * decisions of one request land in one transaction, or none do.
 */

/** Longest rejection reason kept — it lands in the fix agent's prompt. */
export const BASELINE_REASON_MAX = 1000;

export type BaselineDecisionRequest =
  | { kind: 'approve'; indices: readonly number[] }
  /** Approve every entry the host sees as pending; a rejected entry is never touched. */
  | { kind: 'approve-all' }
  | { kind: 'reject'; index: number; reason: string }
  /**
   * Send every entry the host sees as rejected now to fix in one round. Records
   * no rows: the user's earlier rejections are the failed verdict's cause.
   */
  | { kind: 'send-rejections' };

export type BaselineDecisionResult =
  | { kind: 'refused'; reason: string }
  /** Decisions stored; entries still await the user. */
  | { kind: 'pending'; remaining: number }
  /** Every entry approved: the block is cleared and UAT should run again. */
  | { kind: 'approved' }
  /** The rejected entries failed UAT into one fix round. */
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

function validIndices(
  request: Exclude<BaselineDecisionRequest, { kind: 'send-rejections' }>,
  count: number,
): number[] | null {
  if (request.kind === 'approve-all') return null;
  const indices = request.kind === 'approve' ? [...request.indices] : [request.index];
  if (indices.length === 0) return null;
  const ok = indices.every((i) => Number.isInteger(i) && i >= 0 && i < count);
  return ok ? [...new Set(indices)] : null;
}

/** Indices of the entries that still await the user, as the host derives them now. */
function pendingIndices(store: Store, ticketId: number, entries: readonly BaselineEntry[]): number[] {
  const latest = latestBaselineDecisions(store, ticketId);
  return entries.flatMap((entry, i) => (baselineState(entry, latest).kind === 'pending' ? [i] : []));
}

/** One line per rejected entry — the failed verdict's reason, read by the fix agent. */
function rejectionReason(
  rejected: ReadonlyArray<{ path: string; reason: string }>,
  hasPrototype = false,
): string {
  const lines = rejected.map((r) => `Visual baseline rejected: ${r.path}: ${r.reason}`);
  if (hasPrototype) {
    lines.push(PROTOTYPE_REGION_CHECKLIST_RULE);
  }
  return lines.join('\n');
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
  // Re-check after the await: a second message in flight may have moved the
  // ticket out of the review meanwhile. A second failed verdict is the cost.
  if (getTicket(store, ticketId).stageCurrent !== 'uat' || stageBlock(store, ticketId, 'uat')?.kind !== 'baseline-review') {
    return refuse(deps, `${label} is no longer waiting for a baseline review.`);
  }

  if (request.kind === 'send-rejections') {
    const latest = latestBaselineDecisions(store, ticketId);
    const rejected = entries.flatMap((entry) => {
      const state = baselineState(entry, latest);
      return state.kind === 'rejected' ? [{ path: entry.path, reason: state.reason }] : [];
    });
    if (rejected.length === 0) return refuse(deps, `Nothing is rejected for ${label}.`);
    return failUat(deps, rejected, now);
  }

  const indices = request.kind === 'approve-all' ? pendingIndices(store, ticketId, entries) : validIndices(request, entries.length);
  if (indices === null || (request.kind === 'approve-all' && indices.length === 0)) {
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
      decision: request.kind === 'reject' ? ('rejected' as const) : ('approved' as const),
      reason,
    })),
    now(),
  );

  const latest = latestBaselineDecisions(store, ticketId);
  const states = entries.map((entry) => ({ entry, state: baselineState(entry, latest) }));
  const rejected = states.flatMap(({ entry, state }) =>
    state.kind === 'rejected' ? [{ path: entry.path, reason: state.reason }] : [],
  );
  const remaining = states.filter(({ state }) => state.kind === 'pending').length;
  if (remaining > 0) {
    deps.debug?.(`[gate] baseline decision ticket ${ticketId}: ${remaining} still pending`);
    return { kind: 'pending', remaining };
  }
  // No entry is pending: a standing rejection now sends every rejected entry to
  // one fix round. Otherwise the user approved everything.
  if (rejected.length > 0) return failUat(deps, rejected, now);

  clearStageBlock(store, ticketId, 'uat');
  deps.debug?.(`[gate] baseline decision ticket ${ticketId}: all approved — re-driving uat`);
  deps.redrive(ticketId);
  return { kind: 'approved' };
}

/**
 * Send → a FAILED UAT verdict, through the same writer every gate failure uses,
 * so the attempt, the recovery round and the fix prompt all behave as for a red
 * gate. Every rejected entry lands in the one verdict. The earlier gate evidence
 * stays untouched (@arch:RESULTS).
 */
function failUat(
  deps: BaselineDecisionDeps,
  rejected: ReadonlyArray<{ path: string; reason: string }>,
  now: () => string,
): BaselineDecisionResult {
  const { store, ticketId } = deps;
  const run = latestStageRun(store, ticketId, 'uat');
  const ticket = getTicket(store, ticketId);
  const stage = ticket.stages.find((s) => s.stageKey === 'uat');
  const detail = rejectionReason(rejected, hasLinkedPrototype(ticket));
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
  deps.notify.info(`Sent ${rejected.length} rejected ${rejected.length === 1 ? 'baseline' : 'baselines'} of ${formatId('ticket', ticketId)} to fix.`, ticketId);
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
 * The three dashboard actions, ready to spread into `DashboardActions`. The
 * block id is checked here (only `baseline-review` is decidable); every other
 * check lives in `decideBaselines`.
 */
export function makeBaselineActions(deps: BaselineActionsDeps): {
  baselineApprove: (blockId: string, indices: number[]) => Promise<void>;
  baselineApproveAll: (blockId: string) => Promise<void>;
  baselineReject: (blockId: string, index: number, reason: string) => Promise<void>;
  baselineSendRejections: (blockId: string) => Promise<void>;
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
    baselineApproveAll: (blockId) => run(blockId, { kind: 'approve-all' }),
    baselineReject: (blockId, index, reason) => run(blockId, { kind: 'reject', index, reason }),
    baselineSendRejections: (blockId) => run(blockId, { kind: 'send-rejections' }),
  };
}
