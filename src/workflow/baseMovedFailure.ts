import type { Store } from '../store/db.js';
import { stageBlock } from '../store/stageBlocks.js';
import { getDeliverRun, listDeliverResults, type DeliverGateResult, type DeliverRun } from '../store/deliverRuns.js';
import { sendBackState, type SendBackUnavailableReason } from './sendBack.js';

/**
 * "Send gate failure to agent": the availability rule for the ship-stage action (@arch:SHIP-CI-ACTIONS).
 *
 * It rides on `sendBackState`, so the in-flight and landed refusals cannot drift from the plain send-back. On top it
 * needs the ship block `base-moved-failed` (@arch:BLOCKED) and the newest `base-moved` run of the ticket to have
 * `failed`: the block text alone is not evidence, the run row is.
 */
export type BaseMovedFailureUnavailableReason = SendBackUnavailableReason | 'no-block' | 'no-failed-run';

export interface BaseMovedFailureRun {
  readonly run: DeliverRun;
  /** The block reason: `<repo>: gate "<name>" fails when merged with origin/<base> <sha> - <line>`. */
  readonly reason: string;
  /** The gates of the run that exited non-zero, in run order. */
  readonly failed: readonly DeliverGateResult[];
}

export type BaseMovedFailureState =
  | ({ available: true } & BaseMovedFailureRun)
  | { available: false; reason: BaseMovedFailureUnavailableReason };

/** The newest `base-moved` run of the ticket, whatever its state; null when none ran. */
function latestBaseMovedRun(store: Store, ticketId: number): DeliverRun | null {
  const row = store.db
    .prepare("SELECT id FROM deliver_runs WHERE ticket_id = ? AND kind = 'base-moved' ORDER BY id DESC LIMIT 1")
    .get(ticketId) as { id: number } | undefined;
  return row ? getDeliverRun(store, row.id) : null;
}

export function baseMovedFailureState(store: Store, ticketId: number): BaseMovedFailureState {
  const sb = sendBackState(store, ticketId);
  if (!sb.available) return { available: false, reason: sb.reason };
  if (sb.stage !== 'ship') return { available: false, reason: 'stage' };
  const block = stageBlock(store, ticketId, 'ship');
  if (block?.kind !== 'base-moved-failed') return { available: false, reason: 'no-block' };
  const run = latestBaseMovedRun(store, ticketId);
  if (run === null || run.state !== 'failed') return { available: false, reason: 'no-failed-run' };
  const failed = listDeliverResults(store, ticketId).filter((g) => g.runId === run.id && g.exitCode !== null && g.exitCode !== 0);
  return { available: true, run, reason: block.reason ?? '', failed };
}
