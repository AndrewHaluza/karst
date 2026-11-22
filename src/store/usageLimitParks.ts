import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';
import { nowIso } from '../model/time.js';
import { setStage } from './stages.js';
import { classifyFailure } from '../agent/failureClass.js';
import { UsageLimitError, parseUsageLimitResetAt } from '../agent/cliFailure.js';

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
 * - `interactive`: written by `extension/ops/interactiveUsageLimitOps.ts` (D160, arch:AC-42).
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
  resolution   TEXT,
  reset_at       TEXT,
  carry_provider TEXT,
  carry_model    TEXT,
  carry_until    TEXT
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
  /**
   * The instant the limit resets, when the caller knows it. Absent → parsed
   * from `detail` (`parseUsageLimitResetAt`); null when neither names one.
   */
  resetAt?: string | null;
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
  /** The instant the limit resets (v136, T1313); null = unknown. */
  resetAt: string | null;
  /** The carried pick (v136, @arch:AC-65): the core/model later lanes use; null = one-shot. */
  carryProvider: string | null;
  carryModel: string | null;
  /** The carry ends at this instant; null = no carry. */
  carryUntil: string | null;
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
  reset_at: string | null;
  carry_provider: string | null;
  carry_model: string | null;
  carry_until: string | null;
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
    resetAt: r.reset_at ?? null,
    carryProvider: r.carry_provider ?? null,
    carryModel: r.carry_model ?? null,
    carryUntil: r.carry_until ?? null,
  };
}

/** The open row for this key, or null. COALESCE makes NULL keys compare equal. */
function findOpenId(store: Store, input: UsageLimitParkInput): { id: number; keptOutcome: string | null } | null {
  const row = store.db
    .prepare(
      `SELECT id, kept_outcome FROM usage_limit_parks
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
    ) as { id: number; kept_outcome: string | null } | undefined;
  return row ? { id: row.id, keptOutcome: row.kept_outcome ?? null } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The `repo` a kept-outcome target entry names, when it names one. */
function targetRepo(target: unknown): string | undefined {
  return isRecord(target) && typeof target.repo === 'string' ? target.repo : undefined;
}

/** The union of two observation lists, in order, without repeats. */
function unionObservations(prior: readonly unknown[], fresh: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const observation of [...prior, ...fresh]) {
    const key = JSON.stringify(observation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(observation);
  }
  return out;
}

/**
 * Merge a fresh kept outcome into the one the open row already carries.
 *
 * A SECOND park at the same key must never lose what the FIRST park kept: the
 * fresh outcome names only the target THIS run touched, so a quota stop that
 * lands earlier in the target list would drop a sibling target's observations
 * (the UAT lane) — the very evidence D159's re-run exists to preserve. The
 * fresh entry wins for the target it names (a re-parked target reads
 * `usage-limited`, not its stale prior status); every other target's entry is
 * carried forward, and the observation lists are unioned.
 *
 * Shape-agnostic on purpose: `kept_outcome` is opaque JSON whose `targets`
 * array is the only structure both lanes share.
 */
function mergeKeptOutcome(prior: string | null, fresh: string | null): string | null {
  if (prior === null) return fresh;
  if (fresh === null) return prior;
  let priorParsed: unknown;
  let freshParsed: unknown;
  try {
    priorParsed = JSON.parse(prior);
  } catch {
    return fresh;
  }
  try {
    freshParsed = JSON.parse(fresh);
  } catch {
    return prior;
  }
  if (!isRecord(priorParsed) || !isRecord(freshParsed)) return fresh;

  const priorTargets = Array.isArray(priorParsed.targets) ? priorParsed.targets : [];
  const freshTargets = Array.isArray(freshParsed.targets) ? freshParsed.targets : [];
  const freshRepos = new Set(
    freshTargets
      .map(targetRepo)
      .filter((repo): repo is string => repo !== undefined),
  );
  const preserved = priorTargets.filter((target) => {
    const repo = targetRepo(target);
    return repo === undefined || !freshRepos.has(repo);
  });

  const merged: Record<string, unknown> = {
    ...priorParsed,
    ...freshParsed,
    targets: [...preserved, ...freshTargets],
  };
  const priorObservations = Array.isArray(priorParsed.observations) ? priorParsed.observations : [];
  const freshObservations = Array.isArray(freshParsed.observations) ? freshParsed.observations : [];
  if (priorObservations.length > 0 || freshObservations.length > 0) {
    merged.observations = unionObservations(priorObservations, freshObservations);
  }
  return JSON.stringify(merged);
}

/**
 * Record an open usage-limit park. Idempotent per key: a re-park UPDATES the
 * open row in place (fresh detail/provider/model/parked_at) rather than
 * inserting a duplicate, which the partial unique index would reject. The
 * `kept_outcome` is MERGED with the one the row already carries, so a second
 * park at the same key never loses what the first park kept. Returns the row
 * id. The caller owns the transaction — never call it outside one on a path
 * that must commit atomically with a stage write.
 */
export function insertOpenPark(store: Store, input: UsageLimitParkInput): number {
  const parkedAt = input.parkedAt ?? nowIso();
  const stageRunId = input.stageRunId ?? null;
  const model = input.model ?? null;
  const keptOutcome = input.keptOutcome ?? null;
  const resetAt =
    input.resetAt !== undefined ? input.resetAt : parseUsageLimitResetAt(input.detail, new Date(parkedAt));
  const existing = findOpenId(store, input);
  if (existing !== null) {
    store.db
      .prepare(
        `UPDATE usage_limit_parks
         SET stage_run_id = ?, provider = ?, model = ?, detail = ?, kept_outcome = ?, parked_at = ?, reset_at = ?
         WHERE id = ?`,
      )
      .run(
        stageRunId,
        input.provider,
        model,
        input.detail,
        mergeKeptOutcome(existing.keptOutcome, keptOutcome),
        parkedAt,
        resetAt,
        existing.id,
      );
    return existing.id;
  }
  const info = store.db
    .prepare(
      `INSERT INTO usage_limit_parks
         (ticket_id, stage, kind, lane, target, session_id, stage_run_id,
          provider, model, detail, kept_outcome, parked_at, reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      resetAt,
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

/** What an opt-in carried pick writes on the claimed row (@arch:AC-65). */
export interface CarriedPickInput {
  provider: string;
  model: string | null;
  /** ISO-8601: the carry ends at this instant. */
  until: string;
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
  /**
   * The opt-in carried pick (@arch:AC-65): written in the SAME conditional
   * UPDATE as `resolved_at`, so only the claim winner's carry lands. Absent →
   * one-shot (the default, D159); the carry columns stay NULL.
   */
  carry?: CarriedPickInput,
): ClaimParkResult {
  const resolvedAt = at ?? nowIso();
  const apply = store.db.transaction((): ClaimParkResult => {
    const raw = store.db
      .prepare(
        `UPDATE usage_limit_parks
         SET resolved_at = ?, resolution = ?, carry_provider = ?, carry_model = ?, carry_until = ?
         WHERE id = ? AND resolved_at IS NULL
         RETURNING *`,
      )
      .get(
        resolvedAt,
        resolution,
        carry?.provider ?? null,
        carry ? carry.model : null,
        carry?.until ?? null,
        parkId,
      ) as RawParkRow | undefined;

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

/**
 * Undo a claim whose re-run ended WITHOUT a verdict (a Stop, or a failure
 * before the lane could report). The claim exists to keep two windows from
 * running the same lane, not to promise a verdict: consuming the park on a run
 * that never reported would take away the user's only recovery control — the
 * banner is gone, the stage is unblocked, and no run stands in for it.
 *
 * One transaction: null the row's resolution, then re-block a `stage-block`
 * park's stage through `setStage` (single writer). `setStage`'s own clear seam
 * is a no-op here because the stage's prior blocked kind is NULL. A row that is
 * still open (never claimed, or already re-opened) is left alone; returns false.
 */
export function reopenUsageLimitPark(
  store: Store,
  parkId: number,
  opts: { reason?: string; at?: string } = {},
): boolean {
  const at = opts.at ?? nowIso();
  const apply = store.db.transaction((): boolean => {
    const raw = store.db
      .prepare(
        `UPDATE usage_limit_parks
         SET resolved_at = NULL, resolution = NULL,
             carry_provider = NULL, carry_model = NULL, carry_until = NULL
         WHERE id = ? AND resolved_at IS NOT NULL
         RETURNING *`,
      )
      .get(parkId) as RawParkRow | undefined;

    if (!raw) {
      return false;
    }

    const park = rowToPark(raw);
    if (park.kind === 'stage-block' && park.stage !== null) {
      setStage(store, park.ticketId, park.stage as StageKey, {
        blockedKind: 'usage-limit',
        blockedReason: opts.reason ?? park.detail,
        blockedAt: at,
      });
    }
    return true;
  });

  return apply();
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
    // The raw provider text first: the stored sentence caps it.
    ...(limit?.detail
      ? { resetAt: resetFromTexts([limit.detail, limit.message], input.parkedAt) }
      : {}),
  });
}

function resetFromTexts(texts: readonly string[], parkedAt: string | undefined): string | null {
  const now = new Date(parkedAt ?? nowIso());
  for (const text of texts) {
    const at = parseUsageLimitResetAt(text, now);
    if (at !== null) return at;
  }
  return null;
}

const TERMINAL_STAGES = new Set(['done', 'closed']);

function isLiveTicket(store: Store, ticketId: number): boolean {
  const row = store.db
    .prepare('SELECT stage_current, archived_at FROM tickets WHERE id = ?')
    .get(ticketId) as { stage_current: string | null; archived_at: string | null } | undefined;
  return !!row && row.archived_at === null && !TERMINAL_STAGES.has(row.stage_current ?? '');
}

function isAfter(iso: string | null, now: Date): boolean {
  if (iso === null) return false;
  const at = Date.parse(iso);
  return !Number.isNaN(at) && at > now.getTime();
}

/**
 * The ticket's carried picks still in force at `now`, newest claim first
 * (@arch:AC-65). A carry is a claimed `pick` row with `carry_provider` set and
 * `carry_until > now`; `carry_until <= now` ended it with no write. A done,
 * closed or archived ticket has none.
 */
export function listActiveCarries(store: Store, ticketId: number, now: Date): UsageLimitParkRow[] {
  if (!isLiveTicket(store, ticketId)) return [];
  const rows = store.db
    .prepare(
      `SELECT * FROM usage_limit_parks
       WHERE ticket_id = ? AND resolved_at IS NOT NULL AND resolution = 'pick'
         AND carry_provider IS NOT NULL AND carry_until IS NOT NULL
       ORDER BY resolved_at DESC, id DESC`,
    )
    .all(ticketId) as RawParkRow[];
  return rows.map(rowToPark).filter((p) => isAfter(p.carryUntil, now));
}

/**
 * The lane guard's one read (@arch:AC-65): the newest active carry of this
 * ticket whose PARKED provider is `provider` (the lane's resolved core), or
 * null. Pure read — no write, no Settings, no role.
 */
export function resolveCarriedPick(
  store: Store,
  ticketId: number,
  provider: string,
  now: Date,
): UsageLimitParkRow | null {
  return listActiveCarries(store, ticketId, now).find((p) => p.provider === provider) ?? null;
}

/**
 * "Stop using pick": end one carry now by setting `carry_until = at`. Only a
 * row of `ticketId` whose carry is still in force changes; returns true when
 * one did.
 */
export function stopCarriedPick(store: Store, ticketId: number, parkId: number, at: Date): boolean {
  const active = listActiveCarries(store, ticketId, at).some((p) => p.id === parkId);
  if (!active) return false;
  const info = store.db
    .prepare('UPDATE usage_limit_parks SET carry_until = ? WHERE id = ? AND ticket_id = ?')
    .run(at.toISOString(), parkId, ticketId);
  return info.changes > 0;
}
