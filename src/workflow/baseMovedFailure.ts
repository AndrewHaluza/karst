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

const REMOTE = 'origin';
const SHA_SHOWN = 9;

/** `<repo>: gate "<name>" failed (exit <n>)[ — <first failing line>]`, the failure string of `runShipGates`. */
const GATE_FAILURE = /^(.+?): gate "([^"]+)" failed \(exit -?\d+\)(?: — (.*))?$/s;

/**
 * The reason a failed merged run gives for the ship block `base-moved-failed` (@arch:BLOCKED, @arch:SHIP-CI-ACTIONS offers
 * the action): `<repo>: gate "<name>" fails when merged with origin/<base> <sha> - <first failing test line>`. A failure
 * that is not a gate verdict (a refused or stopped gate) keeps its own text after the merge note.
 */
export function baseMovedReason(baseRef: string, baseSha: string, failure: string): string {
  const merged = `fails when merged with ${REMOTE}/${baseRef} ${baseSha.slice(0, SHA_SHOWN)}`;
  const m = GATE_FAILURE.exec(failure);
  if (m === null) return `${merged}; CI tests this merge - ${failure}`;
  const [, repo, gate, detail] = m;
  const line = (detail ?? '').split('\n')[0]?.trim() ?? '';
  return `${repo}: gate "${gate}" ${merged}${line === '' ? '' : ` - ${line}`}`;
}

/**
 * The failure state of the SPECIFIC deliver run an auto-deliver refused on (T1381), not the newest run of any kind. The run
 * must be this ticket's, still `failed`, and have a readable base ref and base sha; `failed` holds only the gates that exited
 * non-zero. `reason` is formatted with `baseMovedReason`, so `baseRefOf` reads the base from it. A null run id (a refusal
 * that named no run) is `no-failed-run`, never another run.
 */
export function deliverRunFailureState(
  store: Store,
  ticketId: number,
  runId: number | null,
  baseRef: string | null,
  baseSha: string | null,
): BaseMovedFailureState {
  const sb = sendBackState(store, ticketId);
  if (!sb.available) return { available: false, reason: sb.reason };
  if (sb.stage !== 'ship') return { available: false, reason: 'stage' };
  if (baseRef === null || baseRef.trim() === '' || baseSha === null || baseSha.trim() === '') {
    return { available: false, reason: 'no-failed-run' };
  }
  const run = getDeliverRun(store, runId);
  if (run === null || run.ticketId !== ticketId || run.state !== 'failed') return { available: false, reason: 'no-failed-run' };
  const failed = listDeliverResults(store, ticketId).filter((g) => g.runId === run.id && g.exitCode !== null && g.exitCode !== 0);
  const first = failed[0];
  let reason: string;
  if (first === undefined) {
    reason = baseMovedReason(baseRef, baseSha, 'a ship gate failed');
  } else {
    const summary = first.summary?.trim() ?? '';
    const failure = `${first.repo}: gate "${first.gateName}" failed (exit ${first.exitCode})${summary === '' ? '' : ` — ${summary}`}`;
    reason = baseMovedReason(baseRef, baseSha, failure);
  }
  return { available: true, run, reason, failed };
}

/**
 * The newest deliver run of the ticket that the base-moved block can name: a ship base check (`base-moved`) or the gate run
 * of an auto-deliver that refused a resolved merge (`auto`, T1381), whatever its state; null when none ran.
 */
function latestBaseMovedRun(store: Store, ticketId: number): DeliverRun | null {
  const row = store.db
    .prepare("SELECT id FROM deliver_runs WHERE ticket_id = ? AND kind IN ('auto', 'base-moved') ORDER BY id DESC LIMIT 1")
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

/**
 * The failed gates of the repo in the newest `base-moved` run (or the auto-deliver run that refused a resolved merge) of the
 * ticket, in run order; empty when the run did not fail or none ran. Ship reads it right after the check failed, before it
 * parks the ship stage (T1169, D633).
 */
export function latestBaseMovedFailedGates(store: Store, ticketId: number, repo: string): readonly DeliverGateResult[] {
  const run = latestBaseMovedRun(store, ticketId);
  if (run === null || run.state !== 'failed') return [];
  return listDeliverResults(store, ticketId).filter((g) => g.runId === run.id && g.repo === repo && g.exitCode !== null && g.exitCode !== 0);
}
