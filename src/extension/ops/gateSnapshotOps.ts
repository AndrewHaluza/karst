import type { Store } from '../../store/db.js';
import { getGateSnapshot, setGateSnapshot } from '../../store/ticketGates.js';
import type { GateOptions } from '../../ui/dashboard/gateOptions.js';

/**
 * Take a ticket's gate-set snapshot (@arch:GATE-SNAPSHOT): the RESOLVED gate names
 * per stage, as the dashboard's gate list shows them. A gate added to the manifest
 * later is not in it, so it is skipped for the ticket until "Rebase on base"
 * takes a new snapshot.
 */
export interface GateSnapshotDeps {
  readonly store: Store;
  /** The resolved gate names the stages would run now (`buildGateOptionsLoader`). */
  readonly loadGateOptions: (ticketId: number) => Promise<GateOptions>;
  readonly debug?: (message: string) => void;
}

/**
 * True when a snapshot was written. Best effort: a failed read never throws, and an
 * answer with no gate in either stage is treated as a failed read — an empty
 * snapshot would skip every gate of the ticket.
 */
export async function takeGateSnapshot(
  d: GateSnapshotDeps,
  ticketId: number,
  opts: { readonly onlyIfMissing?: boolean } = {},
): Promise<boolean> {
  if (opts.onlyIfMissing === true && getGateSnapshot(d.store, ticketId) !== null) return false;
  try {
    const options = await d.loadGateOptions(ticketId);
    if (options.uat.length === 0 && options.review.length === 0) {
      d.debug?.(`[gate] snapshot ticket ${ticketId}: no gate resolved, snapshot not written`);
      return false;
    }
    setGateSnapshot(d.store, ticketId, {
      uat: options.uat.map((g) => g.name),
      review: options.review.map((g) => g.name),
    });
    d.debug?.(`[gate] snapshot ticket ${ticketId}: uat ${options.uat.length}, review ${options.review.length} gate(s)`);
    return true;
  } catch (err) {
    d.debug?.(`[gate] snapshot ticket ${ticketId}: not written (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
