import type { Store } from '../../store/db.js';
import { listPlanningSessions, setPlanningSessionStatus } from '../../store/planningSessions.js';
import { listSessionProposals } from '../../store/planningProposals.js';
import type { Manifest } from '../../manifest/types.js';
import { DEFAULT_ARCHIVE_PLANNING_AFTER_DAYS } from '../../manifest/schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PlanningAutoArchiveInput {
  store: Store;
  projectId: number;
  /** Manifest `archivePlanningAfterDays` (positive whole number by validation). */
  afterDays: number;
  /** Test seam: the sweep's clock. */
  now?: Date;
  /** Is a planning terminal currently open for this session? */
  isLive: (sessionId: number) => boolean;
}

/** SQLite `datetime('now')` text (UTC, no zone) to epoch ms. */
export interface PlanningArchiveSweepDeps {
  store: Store;
  projectId: number;
  manifest: Pick<Manifest, 'archivePlanningAfterDays'> | undefined;
  isLive: (sessionId: number) => boolean;
  logError: (message: string, err: unknown) => void;
}

/** The periodic-sweep entry: manifest delay (default 3), fault-isolated. */
export function sweepPlanningArchive(deps: PlanningArchiveSweepDeps): number[] {
  try {
    return autoArchivePlanningSessions({
      store: deps.store,
      projectId: deps.projectId,
      afterDays: deps.manifest?.archivePlanningAfterDays ?? DEFAULT_ARCHIVE_PLANNING_AFTER_DAYS,
      isLive: deps.isLive,
    });
  } catch (e) {
    deps.logError('karst: planning session auto-archive failed', e);
    return [];
  }
}

function sqliteMs(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`);
}

/**
 * Archive FINISHED planning sessions idle for `afterDays`: not already archived,
 * no live terminal, no pending draft, and either `filed` or holding accepted
 * drafts only (discarded ones do not count). Idleness is measured from the newest
 * of the session's and its drafts' `updated_at`. Pure store bookkeeping, so
 * re-runs select nothing (archived sessions are skipped).
 */
export function autoArchivePlanningSessions(input: PlanningAutoArchiveInput): number[] {
  const cutoff = (input.now ?? new Date()).getTime() - input.afterDays * DAY_MS;
  const archived: number[] = [];
  for (const s of listPlanningSessions(input.store, input.projectId)) {
    if (input.isLive(s.id)) continue;
    const all = listSessionProposals(input.store, s.id);
    const kept = all.filter((p) => p.status !== 'discarded');
    if (kept.some((p) => p.status === 'pending')) continue;
    if (s.status !== 'filed' && kept.length === 0) continue;
    const last = Math.max(sqliteMs(s.updatedAt), ...all.map((p) => sqliteMs(p.updatedAt)));
    if (last > cutoff) continue;
    setPlanningSessionStatus(input.store, s.id, 'archived');
    archived.push(s.id);
  }
  return archived;
}
