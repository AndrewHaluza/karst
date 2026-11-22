/**
 * Host binding logic for the auto impl marker (@arch:IMPLUAT): fire the
 * guarded marker for a marker-ready graph run, then hand the ticket to the
 * driver and refresh the views. A completed run has no live agent to split an
 * oversize docs block, so this path runs no docs block cap check: the `docs`
 * gate catches it in UAT and opens a fix round. vscode-free; `extension.ts`
 * only wires it.
 */

import type { Store } from '../../store/db.js';
import { tryAutoFireGraphImplMarker } from '../../workflow/graphMarkerGuard.js';

export interface AutoMarkerDeps {
  store: Store;
  debug: (message: string) => void;
  drive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  now?: () => string;
}

export async function autoFireImplMarker(
  deps: AutoMarkerDeps,
  ticketId: number,
  graphRunId: number,
): Promise<void> {
  try {
    const outcome = tryAutoFireGraphImplMarker(
      deps.store,
      ticketId,
      graphRunId,
      deps.now ?? (() => new Date().toISOString()),
    );
    if (outcome.kind === 'fired') {
      deps.debug(`[graph] run ${graphRunId}: auto impl marker fired`);
      deps.drive(ticketId);
    } else if (outcome.kind === 'refused' && outcome.firstTime) {
      deps.debug(`[graph] run ${graphRunId}: auto impl marker refused — ${outcome.reason}`);
    }
    // Refresh only on a change: a parked run that stays refused costs no repaint per sweep.
    if (outcome.kind === 'fired' || ((outcome.kind === 'refused' || outcome.kind === 'paused') && outcome.firstTime)) {
      deps.refresh(ticketId);
    }
  } catch (e) {
    deps.debug(`[graph] run ${graphRunId}: auto impl marker failed — ${String(e)}`);
  }
}
