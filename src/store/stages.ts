import type { Store } from './db.js';
import { subtaskStageEvent } from './stageEvents.js';
import { clearAutostartOnScopePass } from './autostart.js';
import { postMessage, type PostMessageInput } from './ticketMessages.js';
import type { BlockerKind, StageKey, StageStatus } from '../model/types.js';

export interface Stage {
  ticketId: number;
  stageKey: StageKey;
  status: StageStatus;
  attempt: number;
  verdict: string | null;
  artifactPath: string | null;
  startedAt: string | null;
  endedAt: string | null;
  blockedKind: BlockerKind | null;
  blockedReason: string | null;
  blockedAt: string | null;
}

/** Fields a caller may patch on a stage. Omitted fields are left untouched. */
export interface StagePatch {
  status?: StageStatus;
  attempt?: number;
  verdict?: string | null;
  artifactPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  blockedKind?: BlockerKind | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
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
  blocked_kind: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
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
    blockedKind: (r.blocked_kind as BlockerKind | null) ?? null,
    blockedReason: r.blocked_reason,
    blockedAt: r.blocked_at,
  };
}

/** Read one stage row; null when the ticket has no row for that stage yet. */
export function getStage(store: Store, ticketId: number, stageKey: StageKey): Stage | null {
  const row = store.db
    .prepare('SELECT * FROM stages WHERE ticket_id = ? AND stage_key = ?')
    .get(ticketId, stageKey) as StageRow | undefined;
  return row ? rowToStage(row) : null;
}

/** Map patch field names → DB columns, so only provided fields are updated. */
const COLUMN: Record<keyof StagePatch, string> = {
  status: 'status',
  attempt: 'attempt',
  verdict: 'verdict',
  artifactPath: 'artifact_path',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  blockedKind: 'blocked_kind',
  blockedReason: 'blocked_reason',
  blockedAt: 'blocked_at',
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

export interface SetStageOptions {
  /**
   * Told when the sub-task event derived from this write could not be stored.
   * The stage write still stands. Injected, never a global logger.
   */
  onEventError?: (err: unknown) => void;
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
  opts: SetStageOptions = {},
): void {
  const keys = (Object.keys(patch) as (keyof StagePatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  if (keys.length === 0) return;

  const assignments = keys.map((k) => `${COLUMN[k]} = ?`).join(', ');
  const values = keys.map((k) => patch[k] as string | number | null);

  // Outer savepoint: the pre-write read that derives a sub-task event and the
  // write itself are one atomic unit. SAVEPOINT (not `db.transaction`) nests
  // inside a caller's transaction on both drivers — the CLI's node:sqlite shim
  // would reject a nested BEGIN.
  exec(store, 'SAVEPOINT stage_write');
  try {
    const event = subtaskStageEvent(store, ticketId, stageKey, patch);
    store.db
      .prepare(`UPDATE stages SET ${assignments} WHERE ticket_id = ? AND stage_key = ?`)
      .run(...values, ticketId, stageKey);
    // Leaving scope ends any autostart lifecycle (queued or starting) — the
    // single place it is cleared, so a CLI start and a host start agree.
    if (stageKey === 'scope' && (patch.status === 'passed' || patch.status === 'bypassed')) clearAutostartOnScopePass(store, ticketId);
    if (event !== null) postEventBestEffort(store, event, opts.onEventError);
  } catch (err) {
    rollbackQuietly(store, 'stage_write');
    throw err;
  }
  exec(store, 'RELEASE stage_write');
}

function exec(store: Store, sql: string): void {
  store.db.prepare(sql).run();
}

/** Roll back to and release a savepoint without ever masking the caller's error. */
function rollbackQuietly(store: Store, name: string): void {
  try {
    exec(store, `ROLLBACK TO ${name}`);
  } catch {
    // The original error is what the caller needs; a failed rollback here
    // means the savepoint is already gone with the enclosing transaction.
  }
  try {
    exec(store, `RELEASE ${name}`);
  } catch {
    // Same: nothing to release.
  }
}

/**
 * A notification must never fail or undo the stage write: the event runs in
 * its own nested savepoint, and any failure is rolled back, reported through
 * the injected callback, and swallowed.
 */
function postEventBestEffort(
  store: Store,
  event: PostMessageInput,
  onEventError: ((err: unknown) => void) | undefined,
): void {
  try {
    exec(store, 'SAVEPOINT stage_event');
  } catch (err) {
    onEventError?.(err);
    return;
  }
  try {
    postMessage(store, event);
    exec(store, 'RELEASE stage_event');
  } catch (err) {
    rollbackQuietly(store, 'stage_event');
    onEventError?.(err);
  }
}
