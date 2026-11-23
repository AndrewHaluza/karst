import type { Store } from '../../store/db.js';
import { hostParkCandidates } from '../../store/hostRerunRound.js';
import { isHostParkReason } from '../../workflow/fixParkReason.js';
import { fixParkStoppedText, type TicketLabeler } from '../../model/notifyText.js';
import type { Notify } from './notify.js';

export interface FixParkNotifyDeps {
  readonly store: Store;
  readonly projectId: () => number | undefined;
  readonly notify: Notify;
  /** The toast label of a ticket; the binding owns the store read (@arch:NTF-03). */
  readonly labelOf: TicketLabeler;
}

/**
 * Warn once for each host park that stops a fix round (`@arch:AC-66`). The host CLI writes the
 * same-head park, so a sweep that only watches its own runs would miss it. The first tick after a
 * reload only records the parked rounds it finds: an old park already reads as Needs you, and a
 * toast for it would be noise. A later tick warns for each NEW round id, and `notify.warn` writes
 * the `karst_events` row. A Retry that fails again opens a new round, so it warns again.
 */
export function makeFixParkNotifier(deps: FixParkNotifyDeps): () => void {
  const seen = new Set<number>();
  let primed = false;
  return () => {
    const projectId = deps.projectId();
    if (projectId === undefined) return;
    const parks = hostParkCandidates(deps.store, projectId).filter((r) => isHostParkReason(r.endReason));
    if (!primed) {
      primed = true;
      for (const r of parks) seen.add(r.roundId);
      return;
    }
    for (const r of parks) {
      if (seen.has(r.roundId)) continue;
      seen.add(r.roundId);
      deps.notify.warn(fixParkStoppedText(deps.labelOf(r.ticketId)), r.ticketId);
    }
  };
}
