import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { getGateSnapshot, setGateSnapshot } from '../../store/ticketGates.js';
import { collectGateSnapshot, type BaseDefines } from '../../workflow/stages/gateSnapshot.js';
import type { ScriptProbe } from '../../workflow/gates/probe.js';

/**
 * Take a ticket's gate-set snapshot (@arch:GATE-SNAPSHOT): the RESOLVED gate names
 * per stage over EVERY repository the ticket owns, changed or not. A gate added to
 * the manifest later is not in it, so it is skipped for the ticket until "Rebase on
 * base" takes a new snapshot.
 */
export interface GateSnapshotDeps {
  readonly store: Store;
  readonly manifest: () => Manifest | undefined;
  readonly probe?: (cwd: string) => ScriptProbe;
  readonly baseDefines?: BaseDefines;
  readonly debug?: (message: string) => void;
}

/**
 * True when a snapshot was written. Best effort and never rejects: every read is
 * inside the guard, so a fire-and-forget caller cannot leak an unhandled
 * rejection. An answer with no gate in either stage is treated as a failed read —
 * an empty snapshot would skip every gate of the ticket.
 */
export async function takeGateSnapshot(
  d: GateSnapshotDeps,
  ticketId: number,
  opts: { readonly onlyIfMissing?: boolean } = {},
): Promise<boolean> {
  try {
    // A ticket that already ran gates predates the snapshot: it keeps every gate (@arch:GATE-SNAPSHOT).
    if (opts.onlyIfMissing === true && (getGateSnapshot(d.store, ticketId) !== null || listGateRuns(d.store, ticketId).length > 0)) return false;
    const manifest = d.manifest();
    if (!manifest) {
      d.debug?.(`[gate] snapshot ticket ${ticketId}: no manifest, snapshot not written`);
      return false;
    }
    const snapshot = await collectGateSnapshot(manifest, listWorktreesByTicket(d.store, ticketId), d.probe, d.debug, d.baseDefines);
    const uat = snapshot.uat ?? [];
    const review = snapshot.review ?? [];
    if (uat.length === 0 && review.length === 0) {
      d.debug?.(`[gate] snapshot ticket ${ticketId}: no gate resolved, snapshot not written`);
      return false;
    }
    setGateSnapshot(d.store, ticketId, { uat, review });
    d.debug?.(`[gate] snapshot ticket ${ticketId}: uat ${uat.length}, review ${review.length} gate(s)`);
    return true;
  } catch (err) {
    d.debug?.(`[gate] snapshot ticket ${ticketId}: not written (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
