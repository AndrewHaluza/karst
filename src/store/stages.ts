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
 * A stage's current `attempt`, or 0 when it has no row yet.
 *
 * Deliberately does not throw on a missing row: callers use this to label
 * evidence *inside* a transition's transaction, and the machine already has the
 * authoritative missing-stage guard. Throwing a second, different error here
 * would only mask that one.
 */
export function stageAttempt(store: Store, ticketId: number, stageKey: StageKey): number {
  const row = store.db
    .prepare('SELECT attempt FROM stages WHERE ticket_id = ? AND stage_key = ?')
    .get(ticketId, stageKey) as { attempt: number } | undefined;
  return row?.attempt ?? 0;
}

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
