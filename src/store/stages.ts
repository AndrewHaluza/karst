import type { Store } from './db.js';
import type { StageKey, StageStatus } from '../model/types.js';

export interface Stage {
  ticketId: number;
  stageKey: StageKey;
  status: StageStatus;
  attempt: number;
  verdict: string | null;
  artifactPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** Fields a caller may patch on a stage. Omitted fields are left untouched. */
export interface StagePatch {
  status?: StageStatus;
  attempt?: number;
  verdict?: string | null;
  artifactPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

interface StageRow {
  ticket_id: number;
  stage_key: string;
  status: string;
  attempt: number;
  verdict: string | null;
  artifact_path: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export function rowToStage(r: StageRow): Stage {
  return {
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    status: r.status as StageStatus,
    attempt: r.attempt,
    verdict: r.verdict,
    artifactPath: r.artifact_path,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/** Map patch field names → DB columns, so only provided fields are updated. */
const COLUMN: Record<keyof StagePatch, string> = {
  status: 'status',
  attempt: 'attempt',
  verdict: 'verdict',
  artifactPath: 'artifact_path',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

/**
 * Patch a single stage row (single-writer discipline — all stage mutation goes
 * through here). Only the fields present in `patch` are written; the rest are
 * left as-is, so a status-only update never clobbers a stored verdict.
 */
export function setStage(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
  patch: StagePatch,
): void {
  const keys = (Object.keys(patch) as (keyof StagePatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0) return;

  const assignments = keys.map((k) => `${COLUMN[k]} = ?`).join(', ');
  const values = keys.map((k) => patch[k] as string | number | null);
  store.db
    .prepare(`UPDATE stages SET ${assignments} WHERE ticket_id = ? AND stage_key = ?`)
    .run(...values, ticketId, stageKey);
}
