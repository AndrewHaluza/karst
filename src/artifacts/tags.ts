/**
 * Revision tags for a captured file. A running implementation run is the ticket's
 * active session; without one the edit is the user's or a script's, tagged
 * `manual-edit`. Reads the store only; sync, host-agnostic.
 */

import type { Store } from '../store/db.js';
import { listPhaseMarks } from '../store/phaseMarks.js';
import type { RevisionTrailers } from './store.js';

export const SOURCE_WATCHER = 'watcher';
export const SOURCE_MANUAL = 'manual-edit';

export function resolveTrailers(
  store: Store,
  ticketId: number,
  output: { approachId: string; kind: string },
): RevisionTrailers {
  const run = store.db
    .prepare(`SELECT id FROM implementation_runs WHERE ticket_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`)
    .get(ticketId) as { id: number } | undefined;
  const base: RevisionTrailers = { approach: output.approachId, kind: output.kind };
  if (run === undefined) return { ...base, source: SOURCE_MANUAL };
  const stage = store.db.prepare('SELECT stage_current FROM tickets WHERE id = ?').get(ticketId) as
    | { stage_current: string | null }
    | undefined;
  const phase = listPhaseMarks(store, ticketId).at(-1)?.phaseName;
  return {
    ...base,
    source: SOURCE_WATCHER,
    session: String(run.id),
    ...(stage?.stage_current ? { stage: stage.stage_current } : {}),
    ...(phase ? { phase } : {}),
  };
}
