import { join } from 'node:path';

import type { Manifest } from '../manifest/types.js';
import { purgeArchivedGateLogs } from '../runtime/gateLogRetention.js';
import type { Store } from '../store/db.js';
import { findTicketById } from '../store/tickets.js';
import { createArtifactStore, type ArtifactStore } from './store.js';

/** The T2 pass needs nothing of the store but this, so a test can hand in a failing one. */
export type TicketStoreSweep = Pick<ArtifactStore, 'purgeStale'>;

export interface ArtifactTreesSweepDeps {
  /** `<globalStorage>/artifacts` — the parent of `p<projectId>/` and `<ticketId>/`. */
  artifactsRoot: string;
  projectId: number;
  maxAgeDays: number;
  /** Window store, to resolve a gate-log dir's ticket and its archive state. */
  store: Store;
  /** The T2 ticket store of THIS project. */
  ticketStore: TicketStoreSweep;
  now?: () => Date;
  debug: (message: string) => void;
  logError: (message: string, err: unknown) => void;
}

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
  const artifactsRoot = join(deps.globalStorageRoot, 'artifacts');
  return sweepArtifactTrees({
    artifactsRoot,
    projectId: deps.projectId,
    maxAgeDays,
    store: deps.store,
    ticketStore: createArtifactStore({
      artifactsRoot,
      projectId: deps.projectId,
      now: deps.now,
    }),
    now: deps.now,
    debug: deps.debug,
    logError: deps.logError,
  });
}

/**
 * Sweep both trees under `artifactsRoot`. The passes are independent on
 * purpose: a git failure on one T2 store must not leave the archived ticket
 * gate logs — the larger tree — on disk for another cycle (or forever, when the
 * store keeps failing), so a store failure is reported and the gate-log pass
 * still runs.
 */
export async function sweepArtifactTrees(deps: ArtifactTreesSweepDeps): Promise<number[]> {
  const purged = await purgeStaleTicketStores(deps);
  const purgedLogs = await purgeArchivedGateLogs(deps.artifactsRoot, deps.maxAgeDays, {
    archivedAt: (ticketId) =>
      findTicketById(deps.store, ticketId, { projectId: deps.projectId })?.archivedAt,
    now: deps.now,
    debug: deps.debug,
  });
  if (purgedLogs.length > 0)
    deps.debug(`[artifacts] purged ${purgedLogs.length} archived ticket gate-log dir(s)`);
  return [...new Set([...purged, ...purgedLogs])];
}

/**
 * The T2 pass alone, guarded: unlike `purgeStale` (which swallows only a
 * missing root), a failure here is reported and yields no ids so the caller's
 * other pass still runs.
 */
async function purgeStaleTicketStores(deps: ArtifactTreesSweepDeps): Promise<number[]> {
  try {
    const purged = await deps.ticketStore.purgeStale(deps.maxAgeDays);
    if (purged.length > 0) deps.debug(`[artifacts] purged ${purged.length} stale ticket store(s)`);
    return purged;
  } catch (err) {
    deps.logError('karst: artifact store retention sweep failed', err);
    return [];
  }
}
