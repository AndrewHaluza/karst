import { join } from 'node:path';

import type { Manifest } from '../manifest/types.js';
import { purgeArchivedGateLogs } from '../runtime/gateLogRetention.js';
import type { Store } from '../store/db.js';
import { findTicketById } from '../store/tickets.js';
import { createArtifactStore } from './store.js';

/**
 * Periodic retention sweep of the two artifact trees global storage keeps per
 * ticket. Kept forever unless `artifacts.maxAgeDays` is set; then a T2 ticket
 * store whose newest revision is older than that is purged, and so is the
 * gate-log dir (`artifacts/<ticketId>/`) of a ticket archived in this window's
 * project once both its `archived_at` and every file inside are older than
 * that. Returns the purged ticket ids.
 */
export async function sweepArtifactRetention(deps: {
  globalStorageRoot: string;
  projectId: number;
  manifest: Pick<Manifest, 'artifacts'> | undefined;
  store: Store;
  now?: () => Date;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}): Promise<number[]> {
  const maxAgeDays = deps.manifest?.artifacts?.maxAgeDays;
  if (maxAgeDays === undefined) return [];
  try {
    const artifactsRoot = join(deps.globalStorageRoot, 'artifacts');
    const purged = await createArtifactStore({
      artifactsRoot,
      projectId: deps.projectId,
      now: deps.now,
    }).purgeStale(maxAgeDays);
    if (purged.length > 0) deps.debug(`[artifacts] purged ${purged.length} stale ticket store(s)`);
    const purgedLogs = await purgeArchivedGateLogs(artifactsRoot, maxAgeDays, {
      archivedAt: (ticketId) =>
        findTicketById(deps.store, ticketId, { projectId: deps.projectId })?.archivedAt,
      now: deps.now,
      debug: deps.debug,
    });
    if (purgedLogs.length > 0)
      deps.debug(`[artifacts] purged ${purgedLogs.length} archived ticket gate-log dir(s)`);
    return [...new Set([...purged, ...purgedLogs])];
  } catch (err) {
    deps.logError('karst: artifact store retention sweep failed', err);
    return [];
  }
}
