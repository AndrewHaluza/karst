import { join } from 'node:path';

import type { Manifest } from '../manifest/types.js';
import { createArtifactStore } from './store.js';

/**
 * Periodic retention sweep: kept forever unless `artifacts.maxAgeDays` is set,
 * then a ticket store whose newest revision is older than that is purged.
 * Returns the purged ticket ids.
 */
export async function sweepArtifactRetention(deps: {
  globalStorageRoot: string;
  projectId: number;
  manifest: Pick<Manifest, 'artifacts'> | undefined;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}): Promise<number[]> {
  const maxAgeDays = deps.manifest?.artifacts?.maxAgeDays;
  if (maxAgeDays === undefined) return [];
  try {
    const purged = await createArtifactStore({
      artifactsRoot: join(deps.globalStorageRoot, 'artifacts'),
      projectId: deps.projectId,
    }).purgeStale(maxAgeDays);
    if (purged.length > 0) deps.debug(`[artifacts] purged ${purged.length} stale ticket store(s)`);
    return purged;
  } catch (err) {
    deps.logError('karst: artifact store retention sweep failed', err);
    return [];
  }
}
