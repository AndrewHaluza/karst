import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * `stage_runs` (v25) — one row per gate-run INVOCATION, opened before the first
 * gate starts and closed at the outcome.
 *
 * This table exists because "a stage reading `running` with zero `gate_runs`
 * rows" was three-way ambiguous: never started, in flight, or died. `gate_runs`
 * cannot resolve that — it is evidence a gate FINISHED, and a run that produced
 * none is indistinguishable from a run that never happened. Only a record
 * opened at entry can say a run existed at all.
 *
 * A run is never deleted and never rewritten into a lie. `stale` is what a run
 * killed by process death becomes — that is a real, recordable fact, and it is
 * the one the user was owed while a review re-ran invisibly from scratch.
 */
export type StageRunStatus = 'running' | 'finished' | 'stale';

/** How a FINISHED run ended. Mirrors `StageRunResult['kind']`. */
export type StageRunOutcome = 'advanced' | 'blocked' | 'stopped';

export interface StageRun {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  /** The stage's attempt when this run opened — pre-bump, like `gate_runs`. */
  attempt: number;
  /** The batch stamp this run's `gate_runs` rows share. */
  runAt: string;
  status: StageRunStatus;
  /** NULL while running, and on a stale run: how it would have ended is unknown. */
  outcome: StageRunOutcome | null;
  /**
   * The gate-relevant manifest revision this run resolved its gate set from
   * (`manifest/gateRevision.ts`). NULL when no manifest was supplied. Compared
   * against the previous run's to state that a gate SET changed — a gate deleted
   * from the manifest must not read as a gate that was fixed.
   */
  manifestHash: string | null;
  /**
   * The process that opened the run. NULL = unknown, never invented. Used only
   * to decide liveness at activation, and a pid is a recollection, not a handle
   * — the reconcile below acts on it exactly as conservatively as
   * `runtime/serverIdentity.ts` does.
   */
  pid: number | null;
  startedAt: string;
  /**
   * NULL while running AND on a stale run. When a killed run stopped is
   * genuinely unknown — writing the reconcile's own clock there would claim the
   * run lived until the next activation, which may be days.
   */
  endedAt: string | null;
}

interface StageRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  attempt: number;
  run_at: string;
  status: string;
  outcome: string | null;
  manifest_hash: string | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

const STATUSES: readonly string[] = ['running', 'finished', 'stale'];
const OUTCOMES: readonly string[] = ['advanced', 'blocked', 'stopped'];

function rowToStageRun(r: StageRunRow): StageRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    attempt: r.attempt,
    runAt: r.run_at,
    // Both vocabularies are closed and this is a read boundary over an
    // append-only table: an unrecognized value degrades to the conservative
    // answer rather than being carried through as a state no consumer handles.
    status: (STATUSES.includes(r.status) ? r.status : 'stale') as StageRunStatus,
    outcome: r.outcome !== null && OUTCOMES.includes(r.outcome)
      ? (r.outcome as StageRunOutcome)
      : null,
    manifestHash: r.manifest_hash,
    pid: r.pid,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const SELECT =
  `SELECT id, ticket_id, stage_key, attempt, run_at, status, outcome,
          manifest_hash, pid, started_at, ended_at
     FROM stage_runs`;

export interface OpenStageRunInput {
  ticketId: number;
  stageKey: StageKey;
  attempt: number;
  runAt: string;
  manifestHash?: string | null;
  pid?: number | null;
  startedAt: string;
}

/**
 * Open a run and return its id.
 *
 * Any run of the same ticket+stage still marked `running` is marked `stale`
 * first, in the same transaction: a second run cannot start while the first is
 * genuinely live (the driver single-flights per ticket), so one still open here
 * is one whose host died. Marking it at the moment it is SUPERSEDED is what
 * makes the re-run visible — the alternative, waiting for an activation sweep,
 * leaves the destroyed run reading `running` beside the run that replaced it.
 */
export function openStageRun(store: Store, input: OpenStageRunInput): number {
  const apply = store.db.transaction(() => {
    store.db
      .prepare(
        `UPDATE stage_runs SET status = 'stale'
          WHERE ticket_id = ? AND stage_key = ? AND status = 'running'`,
      )
      .run(input.ticketId, input.stageKey);
    store.db
      .prepare(
        `INSERT INTO stage_runs
           (ticket_id, stage_key, attempt, run_at, status, outcome,
            manifest_hash, pid, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL)`,
      )
      .run(
        input.ticketId,
        input.stageKey,
        input.attempt,
        input.runAt,
        input.manifestHash ?? null,
        input.pid ?? null,
        input.startedAt,
      );
  });
  apply();
  const row = store.db
    .prepare(
      `SELECT id FROM stage_runs
        WHERE ticket_id = ? AND stage_key = ? AND run_at = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(input.ticketId, input.stageKey, input.runAt) as { id: number } | undefined;
  if (row === undefined) throw new Error('stage run insert did not land');
  return row.id;
}

/**
 * Close a run with the outcome it reached.
 *
 * Only a run still `running` is closed: a run already marked `stale` was
 * superseded, and letting a late finisher overwrite that would erase the very
 * fact the table records. Opens no transaction — it is called from inside
 * `commitGateOutcome`'s, so the run's closure and the stage's outcome land
 * together.
 */
export function closeStageRun(
  store: Store,
  runId: number,
  outcome: StageRunOutcome,
  endedAt: string,
): void {
  store.db
    .prepare(
      `UPDATE stage_runs SET status = 'finished', outcome = ?, ended_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(outcome, endedAt, runId);
}

/** Every run recorded for a ticket, oldest first (insertion order is run order). */
export function listStageRuns(store: Store, ticketId: number): StageRun[] {
  return store.db
    .prepare(`${SELECT} WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId)
    .map((r) => rowToStageRun(r as StageRunRow));
}

/** The most recent run of a ticket's stage, whatever its status. */
export function latestStageRun(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
): StageRun | null {
  const row = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? AND stage_key = ? ORDER BY id DESC LIMIT 1`)
    .get(ticketId, stageKey) as StageRunRow | undefined;
  return row ? rowToStageRun(row) : null;
}

/**
 * The run before `runId` for the same ticket+stage, whatever its status.
 *
 * A `stale` predecessor counts: it ran, it resolved a gate set, and comparing
 * against it is how "the gate set changed since the previous attempt" is stated
 * (RC5). Skipping it would silently compare against a run two attempts back.
 */
export function previousStageRun(store: Store, run: StageRun): StageRun | null {
  const row = store.db
    .prepare(
      `${SELECT} WHERE ticket_id = ? AND stage_key = ? AND id < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(run.ticketId, run.stageKey, run.id) as StageRunRow | undefined;
  return row ? rowToStageRun(row) : null;
}

/** A run this sweep found dead, reported so the loss is never silent. */
export interface StaleStageRun {
  run: StageRun;
  reason: string;
}

/**
 * Mark every `running` row whose process is gone as `stale`, globally.
 *
 * Global like `reconcileOnStart`'s server pass and for the same reason: the
 * registry is shared by every IDE window, and a run whose host died is wrong in
 * whichever project owns it. What makes that safe is `isAlive`, not the scope —
 * a run opened by ANOTHER LIVE window has a live pid and is left strictly
 * alone. A row with no pid is left alone too: absence of evidence is not
 * evidence the run is dead, and marking one stale would falsely accuse a live
 * run of having been destroyed.
 *
 * Reported, never silent. An invisibly-discarded run is the whole failure this
 * closes; a sweep that fixed the data and said nothing would repeat it.
 */
export function reconcileStageRuns(
  store: Store,
  isAlive: (pid: number) => boolean,
): StaleStageRun[] {
  const rows = store.db
    .prepare(`${SELECT} WHERE status = 'running' ORDER BY id`)
    .all()
    .map((r) => rowToStageRun(r as StageRunRow));

  const stale: StaleStageRun[] = [];
  const mark = store.db.prepare("UPDATE stage_runs SET status = 'stale' WHERE id = ?");
  for (const run of rows) {
    if (run.pid === null) continue;
    if (isAlive(run.pid)) continue;
    mark.run(run.id);
    stale.push({
      run: { ...run, status: 'stale' },
      reason:
        `${run.stageKey} run opened ${run.startedAt} (pid ${run.pid}) did not finish — ` +
        'its process is gone; the stage will run again',
    });
  }
  return stale;
}

/** One line naming a run this sweep found dead, for the output channel. */
export function describeStaleStageRun(s: StaleStageRun): string {
  return `karst: ticket ${s.run.ticketId}: ${s.reason}`;
}
