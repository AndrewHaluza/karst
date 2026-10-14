import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';
import { nowIso } from '../model/time.js';
import { setStage } from './stages.js';
import { classifyFailure } from '../agent/failureClass.js';
import { UsageLimitError } from '../agent/cliFailure.js';

/**
 * `usage_limit_parks` (v82, @arch:V82) — one row per AI operation that stopped
 * because the provider account is out of quota/allowance (K11, D158).
 *
 * A park is not a verdict: the op could not run, so nothing about the code was
 * learned. The stage block (`stages.blocked_kind = 'usage-limit'`) is the
 * user-visible state; this table is the DURABLE record of what stopped, on
 * which provider/model, so a later session (D159's picker/re-run) can offer
 * "pick another agent/model" or "retry same" without re-deriving anything.
 *
 * Three kinds:
 * - `stage-block`: written INSIDE `parkGateStage`, in the same transaction as
 *   the block — review/UAT.
 * - `op`: a non-stage AI op (fix resume, PR description, alignment, classify,
 *   suggest) that failed on quota; `stage` names where it ran. `lane` is NULL
 *   unless the call site names the specific op (`'analysis'`/`'suggest'`), which
 *   D159's re-run dispatches on — and which keeps two different ops at one stage
 *   from collapsing into a single open row.
 * - `interactive`: reserved for the interactive-detection part (D160).
 *
 * At most ONE open park per `(ticket_id, stage, kind, lane, target, session_id)`
 * — an expression partial unique index enforces it and `insertOpenPark` upserts
 * so a re-park refreshes the open row instead of failing. `resolved_at` is
 * cleared by `setStage` when the stage leaves a `usage-limit` block.
 */

/** The DDL `schema.sql` mirrors for a fresh DB (the v82 migration step execs it). */
export const USAGE_LIMIT_PARKS_DDL = `
CREATE TABLE IF NOT EXISTS usage_limit_parks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  stage        TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('stage-block', 'op', 'interactive')),
  lane         TEXT,
  target       TEXT,
  session_id   TEXT,
  stage_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL,
  model        TEXT,
  detail       TEXT NOT NULL,
  kept_outcome TEXT,
  parked_at    TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_limit_parks_ticket
  ON usage_limit_parks(ticket_id, resolved_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_limit_parks_open
  ON usage_limit_parks(
    ticket_id, COALESCE(stage, ''), kind, COALESCE(lane, ''),
    COALESCE(target, ''), COALESCE(session_id, '')
  )
  WHERE resolved_at IS NULL;
`;

export type UsageLimitParkKind = 'stage-block' | 'op' | 'interactive';

/**
 * What a caller (UAT/Review aggregate, an op call site) knows about the park,
 * independent of where it is written. Shared so the blocked outcome union and
 * `parkGateStage` name the same fields.
 */
export interface UsageLimitParkPayload {
  provider: string;
  model: string | null;
  /** The lane within the stage (`review`/`uat`), when the park came from one. */
  lane: string | null;
  /** The repo/target whose call hit the limit, when known. */
  target: string | null;
  /** The bounded one-line diagnostic (the `UsageLimitError` message). */
  detail: string;
  /** JSON of sibling targets' outcomes, kept for D159's merge (optional). */
  keptOutcome: string | null;
}

export interface UsageLimitParkInput extends UsageLimitParkPayload {
  ticketId: number;
  /** The stage the op ran at; NULL for an op with no stage. */
  stage: StageKey | null;
  kind: UsageLimitParkKind;
  sessionId?: string | null;
  stageRunId?: number | null;
  /** Injectable clock; defaults to `nowIso()`. */
  parkedAt?: string;
}

export interface UsageLimitParkRow {
  id: number;
  ticketId: number;
  stage: string | null;
  kind: UsageLimitParkKind;
  lane: string | null;
  target: string | null;
  sessionId: string | null;
  stageRunId: number | null;
  provider: string;
  model: string | null;
  detail: string;
  keptOutcome: string | null;
  parkedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

interface RawParkRow {
  id: number;
  ticket_id: number;
  stage: string | null;
  kind: string;
  lane: string | null;
  target: string | null;
  session_id: string | null;
  stage_run_id: number | null;
  provider: string;
  model: string | null;
  detail: string;
  kept_outcome: string | null;
  parked_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

function rowToPark(r: RawParkRow): UsageLimitParkRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stage: r.stage,
    kind: r.kind as UsageLimitParkKind,
    lane: r.lane,
    target: r.target,
    sessionId: r.session_id,
    stageRunId: r.stage_run_id,
    provider: r.provider,
    model: r.model,
    detail: r.detail,
    keptOutcome: r.kept_outcome,
    parkedAt: r.parked_at,
    resolvedAt: r.resolved_at,
    resolution: r.resolution,
  };
}

/** The open row for this key, or null. COALESCE makes NULL keys compare equal. */
function findOpenId(store: Store, input: UsageLimitParkInput): number | null {
  const row = store.db
    .prepare(
      `SELECT id FROM usage_limit_parks
       WHERE ticket_id = ?
         AND COALESCE(stage, '') = COALESCE(?, '')
         AND kind = ?
         AND COALESCE(lane, '') = COALESCE(?, '')
         AND COALESCE(target, '') = COALESCE(?, '')
         AND COALESCE(session_id, '') = COALESCE(?, '')
         AND resolved_at IS NULL`,
    )
    .get(
      input.ticketId,
      input.stage,
      input.kind,
      input.lane,
      input.target,
      input.sessionId ?? null,
    ) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Record an open usage-limit park. Idempotent per key: a re-park UPDATES the
 * open row in place (fresh detail/provider/model/parked_at) rather than
 * inserting a duplicate, which the partial unique index would reject. Returns
 * the row id. The caller owns the transaction — never call it outside one on a
 * path that must commit atomically with a stage write.
 */
export function insertOpenPark(store: Store, input: UsageLimitParkInput): number {
  const parkedAt = input.parkedAt ?? nowIso();
  const stageRunId = input.stageRunId ?? null;
  const model = input.model ?? null;
  const keptOutcome = input.keptOutcome ?? null;
  const existing = findOpenId(store, input);
  if (existing !== null) {
    store.db
      .prepare(
        `UPDATE usage_limit_parks
         SET stage_run_id = ?, provider = ?, model = ?, detail = ?, kept_outcome = ?, parked_at = ?
         WHERE id = ?`,
      )
      .run(stageRunId, input.provider, model, input.detail, keptOutcome, parkedAt, existing);
    return existing;
  }
  const info = store.db
    .prepare(
      `INSERT INTO usage_limit_parks
         (ticket_id, stage, kind, lane, target, session_id, stage_run_id,
          provider, model, detail, kept_outcome, parked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.stage,
      input.kind,
      input.lane,
      input.target,
      input.sessionId ?? null,
      stageRunId,
      input.provider,
      model,
      input.detail,
      keptOutcome,
      parkedAt,
    );
  return Number(info.lastInsertRowid);
}

/**
 * Resolve every open park for a ticket+stage. The clear seam: `setStage` calls
 * this inside its savepoint when a stage leaves a `usage-limit` block, so
 * `clearStageBlock`, a re-run, a send-back and a sub-task integration that
 * overwrites the block all resolve the park without a second writer.
 */
export function resolveOpenParks(
  store: Store,
  key: { ticketId: number; stage: StageKey | null; resolution: string; at?: string },
): number {
  const info = store.db
    .prepare(
      `UPDATE usage_limit_parks
       SET resolved_at = ?, resolution = ?
       WHERE ticket_id = ?
         AND COALESCE(stage, '') = COALESCE(?, '')
         AND resolved_at IS NULL`,
    )
    .run(key.at ?? nowIso(), key.resolution, key.ticketId, key.stage);
  return info.changes;
}

export type ClaimParkResult =
  | { claimed: true; park: UsageLimitParkRow }
  | { claimed: false; park: null };

/**
 * Claim an open usage-limit park atomically.
 *
 * One transaction:
 * 1. Conditionally updates `usage_limit_parks SET resolved_at=?, resolution=? WHERE id=? AND resolved_at IS NULL RETURNING *`.
 * 2. If 0 rows updated, returns `{ claimed: false, park: null }`.
 * 3. For `stage-block` parks, verifies the stage is currently blocked on `'usage-limit'`.
 *    If not (e.g. concurrent sendBack or retryGate cleared/replaced it), roll back and return `{ claimed: false, park: null }`.
 * 4. For `stage-block` parks, clears the stage block via `setStage`. Since the park row
 *    was already resolved in step 1, `setStage`'s clear seam is a no-op.
 * 5. Returns `{ claimed: true, park }`.
 */
export function claimUsageLimitPark(
  store: Store,
  parkId: number,
  resolution: string,
  at?: string,
): ClaimParkResult {
  const resolvedAt = at ?? nowIso();
  const apply = store.db.transaction((): ClaimParkResult => {
    const raw = store.db
      .prepare(
        `UPDATE usage_limit_parks
         SET resolved_at = ?, resolution = ?
         WHERE id = ? AND resolved_at IS NULL
         RETURNING *`,
      )
      .get(resolvedAt, resolution, parkId) as RawParkRow | undefined;

    if (!raw) {
      return { claimed: false, park: null };
    }

    const park = rowToPark(raw);
    if (park.kind === 'stage-block') {
      const stageKey = park.stage as StageKey;
      const stageRow = store.db
        .prepare('SELECT blocked_kind FROM stages WHERE ticket_id = ? AND stage_key = ?')
        .get(park.ticketId, stageKey) as { blocked_kind: string | null } | undefined;

      if (!stageRow || stageRow.blocked_kind !== 'usage-limit') {
        // Roll back the update inside the transaction by throwing a sentinel or returning abort
        // In SQLite/better-sqlite3, to abort the transaction we can throw or we can revert.
        // But throwing rolls back the transaction.
        throw new Error('STAGE_BLOCK_NOT_USAGE_LIMIT');
      }

      // Clear the stage block via setStage (single-writer invariant).
      setStage(store, park.ticketId, stageKey, {
        blockedKind: null,
        blockedReason: null,
        blockedAt: null,
      });
    }

    return { claimed: true, park };
  });

  try {
    return apply();
  } catch (e) {
    if (e instanceof Error && e.message === 'STAGE_BLOCK_NOT_USAGE_LIMIT') {
      return { claimed: false, park: null };
    }
    throw e;
  }
}

/** Every park (open and resolved) for a ticket, newest first. */
export function listParks(store: Store, ticketId: number): UsageLimitParkRow[] {
  const rows = store.db
    .prepare('SELECT * FROM usage_limit_parks WHERE ticket_id = ? ORDER BY id DESC')
    .all(ticketId) as RawParkRow[];
  return rows.map(rowToPark);
}

/** Only the open parks for a ticket, newest first. */
export function listOpenParks(store: Store, ticketId: number): UsageLimitParkRow[] {
  const rows = store.db
    .prepare(
      'SELECT * FROM usage_limit_parks WHERE ticket_id = ? AND resolved_at IS NULL ORDER BY id DESC',
    )
    .all(ticketId) as RawParkRow[];
  return rows.map(rowToPark);
}

/**
 * Record an op park (kind `op`) for a caught non-stage AI failure — the
 * fix/ship-description/alignment/classify call sites that have no stage-block
 * path. Returns the row id, or null when `error` is NOT a quota exhaustion (so
 * a caller can call it unconditionally in a catch). Idempotent per key via
 * `insertOpenPark`, so two passes of one analysis collapse to one open row.
 */
export function recordUsageLimitOpPark(
  store: Store,
  error: unknown,
  input: {
    ticketId: number;
    stage: StageKey | null;
    provider?: string | null;
    model?: string | null;
    /** The specific op this park belongs to (`'analysis'`/`'suggest'`), when the
     * call site can name one. D159's re-run dispatches on it. */
    lane?: string | null;
    target?: string | null;
    sessionId?: string | null;
    parkedAt?: string;
  },
): number | null {
  if (classifyFailure(error) !== 'usage-limited') return null;
  const limit = error instanceof UsageLimitError ? error : null;
  return insertOpenPark(store, {
    ticketId: input.ticketId,
    stage: input.stage,
    kind: 'op',
    lane: input.lane ?? null,
    target: input.target ?? null,
    sessionId: input.sessionId ?? null,
    stageRunId: null,
    provider: limit?.provider ?? input.provider ?? 'unknown',
    model: limit?.model ?? input.model ?? null,
    detail: limit?.message ?? (error instanceof Error ? error.message : String(error)),
    keptOutcome: null,
    parkedAt: input.parkedAt,
  });
}
