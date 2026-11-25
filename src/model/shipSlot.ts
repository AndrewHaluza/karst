import type { StepperCell } from './stepper.js';

/**
 * The header's ship workflow-action slot, derived host-side from the same ship
 * cell + merge gate the Now line used to narrate. The states are mutually
 * exclusive by construction: confirm/retry/shipping are the ticket acting,
 * waiting-merge is the ticket parked on open PRs, merge-blocked is that park
 * while a conflict needs the user, none is everywhere else.
 *
 * `merge-blocked` is the ONE host verdict that both the header chip and the
 * blocked banner read, so the two can never disagree (Q1, DB-3). It needs the
 * gate's `conflicted` read AND `needsUser`: a CI-running or shipping reading
 * yields the needs-you state (@arch:BLOCKED), and then the chip stays a calm wait.
 *
 * `shipping` covers a RUNNING ship so a freshly-opened panel (no in-flight
 * requestId of its own) still renders the pending button; the webview's own
 * in-flight ship request (`ui/dashboard/app/pendingOps.ts`) composes on top of this in the header.
 */
export type ShipSlot =
  | { kind: 'confirm' }
  | { kind: 'retry'; reason: string | null }
  | { kind: 'shipping' }
  | { kind: 'waiting-merge'; repos: number }
  | { kind: 'merge-blocked'; repos: readonly string[] }
  | { kind: 'none' };

export function buildShipSlot(
  cell: StepperCell | null,
  mergeGate: { kind?: string; repos?: readonly string[] } | undefined,
  needsUser = false,
): ShipSlot {
  if (!cell || cell.stageKey !== 'ship') return { kind: 'none' };
  if (cell.status === 'failed') return { kind: 'retry', reason: cell.reason ?? null };
  // A re-push (an auto-fix round) runs ship over the stored awaiting-merge block: it ships, it does not wait (@arch:BLOCKED).
  if (cell.status === 'running' && cell.blocked?.kind === 'awaiting-merge') return { kind: 'shipping' };
  if (cell.blocked?.kind === 'awaiting-merge') {
    if (needsUser && mergeGate?.kind === 'conflicted' && (mergeGate.repos?.length ?? 0) > 0) {
      return { kind: 'merge-blocked', repos: [...mergeGate.repos!] };
    }
    return { kind: 'waiting-merge', repos: mergeGate?.repos?.length ?? 0 };
  }
  if (cell.status === 'running') return { kind: 'shipping' };
  return { kind: 'confirm' };
}

/** "1 repo no longer merges cleanly": the merge-blocked reason, worded once for the chip and the banner. */
export function mergeBlockedDetail(repos: number): string {
  return repos === 1 ? '1 repo no longer merges cleanly' : `${repos} repos no longer merge cleanly`;
}
