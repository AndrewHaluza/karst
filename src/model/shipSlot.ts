import type { StepperCell } from './stepper.js';

/**
 * The header's ship workflow-action slot, derived host-side from the same ship
 * cell + merge gate the Now line used to narrate. The states are mutually
 * exclusive by construction: confirm/retry/shipping are the ticket acting,
 * waiting-merge is the ticket parked on open PRs, none is everywhere else.
 *
 * `shipping` covers a RUNNING ship so a freshly-opened panel (no in-flight
 * requestId of its own) still renders the pending button; the webview's own
 * shipRequestId hold composes on top of this in the renderer.
 */
export type ShipSlot =
  | { kind: 'confirm' }
  | { kind: 'retry'; reason: string | null }
  | { kind: 'shipping' }
  | { kind: 'waiting-merge'; repos: number }
  | { kind: 'none' };

export function buildShipSlot(
  cell: StepperCell | null,
  mergeGate: { repos?: readonly string[] } | undefined,
): ShipSlot {
  if (!cell || cell.stageKey !== 'ship') return { kind: 'none' };
  if (cell.status === 'failed') return { kind: 'retry', reason: cell.reason ?? null };
  if (cell.blocked?.kind === 'awaiting-merge') {
    return { kind: 'waiting-merge', repos: mergeGate?.repos?.length ?? 0 };
  }
  if (cell.status === 'running') return { kind: 'shipping' };
  return { kind: 'confirm' };
}
