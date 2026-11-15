/**
 * Host binding logic for the auto impl marker (@arch:IMPLUAT): fire the
 * guarded marker for a marker-ready graph run, then hand the ticket to the
 * driver and refresh the views. vscode-free; `extension.ts` only wires it.
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

export function autoFireImplMarker(deps: AutoMarkerDeps, ticketId: number, graphRunId: number): void {
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
  deps.refresh(ticketId);
}
