import type { Store } from './db.js';
import type { ProjectScope } from './tickets.js';
import { setStage } from './stages.js';

/**
 * `ship_runs` + `ship_repo_steps` + `ship_operation_intents` + `ship_commits`
 * (v32) — the durable per-repository ship SAGA.
 *
 * A ship walks each repo through commit, push, PR-description and PR creation —
 * irreversible external operations whose answers only exist AFTER the side
 * effect happened. A crash mid-saga therefore cannot be re-approximated by
 * probing; it is RECONCILED from what was persisted around each operation:
 *
 * - `ship_runs` — one row per ship invocation, opened before the saga starts.
 * - `ship_repo_steps` — one row per (repo, step), opened `running` before the
 *   step's external work and closed `passed`/`failed`/`note` at its outcome.
 * - `ship_operation_intents` — the typed ownership rows. `pre_state_json` is
 *   ALWAYS written before anything touches git/GitHub (status `preparing`);
 *   `intent_json` completes the exact intended effect (status `prepared`)
 *   before the apply. `operation_key` is globally UNIQUE so a crash-and-rerun
 *   re-prepares the SAME operation and is handed the durable row back, never a
 *   second ownership claim. Terminal reconcile statuses are `reconciled`
 *   (adopted), `failed`, or `ambiguous` (a human or unknown writer moved the
 *   world — never permission to prepare, clean up, or repeat).
 * - `ship_commits` — every commit relevant to the ship per repo, tagged
 *   `before-ship` (already present when the saga started) or `created-by-ship`
 *   (the exact intended SHA landed — provenance by expected object id, never
 *   by message heuristics).
 *
 * Same evidence posture as stage_runs/process_runs: append-only, opened at
 * entry, closed at outcome, and every transition is guarded — a late write is
 * never allowed to overwrite a terminal state. The JSON blobs are parsed
 * through CLOSED TypeScript unions keyed by `step`; malformed/unknown data
 * parses to null (the caller's reconcile treats it as `ambiguous`).
 */

export type ShipStep = 'commit' | 'push' | 'describe' | 'pr';

export type ShipRunStatus = 'running' | 'passed' | 'failed' | 'interrupted';

export type ShipStepStatus = 'running' | 'passed' | 'failed' | 'note';

export type ShipOperationIntentStatus =
  | 'preparing'
  | 'prepared'
  | 'applied'
  | 'reconciled'
  | 'failed'
  | 'ambiguous';

/** The statuses a reconcile CLOSES an intent with. */
export type ShipOperationReconcileStatus = 'reconciled' | 'failed' | 'ambiguous';

export type ShipCommitOrigin = 'before-ship' | 'created-by-ship';

export interface ShipRun {
  id: number;
  ticketId: number;
  attempt: number;
  status: ShipRunStatus;
  /**
   * The extension host that opened the run (v34). NULL = unknown (a pre-v34
   * run, or one whose pid never landed) — never read as "alive": the
   * stranded-ship sweep treats a NULL-pid running run as stranded (absence of
   * evidence is not evidence of life), while `reconcileShipRuns` leaves it
   * strictly alone (absence of evidence is not evidence it died). A pid is a
   * recollection, not a handle — both sweeps act on it exactly as
   * conservatively as `reconcileStageRuns` does.
   */
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ShipRepoStep {
  id: number;
  shipRunId: number;
  repo: string;
  step: ShipStep;
  status: ShipStepStatus;
  detail: string;
  prNumber: number | null;
  existedBeforeShip: boolean | null;
  processRunId: number | null;
  /** -> ship_operation_intents.id; NULL = no preparation has begun. */
  operationIntentId: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ShipCommit {
  id: number;
  shipRunId: number;
  repo: string;
  sha: string;
  message: string;
  /** Raw on read: an unrecognized value names neither claim and must not be
   *  coerced into one. */
  origin: string;
}

export interface ShipOperationIntentRow {
  id: number;
  shipRunId: number;
  repo: string;
  step: ShipStep;
  operationKey: string;
  /** Serialized `ShipOperationPreState`; always present. */
  preStateJson: string;
  /** Serialized `ShipOperationIntent`; NULL only while status is `preparing`. */
  intentJson: string | null;
  status: ShipOperationIntentStatus;
  createdAt: string;
  preparedAt: string | null;
  appliedAt: string | null;
  resolvedAt: string | null;
}

/** The exact identity a commit was (or will be) authored/committed with,
 *  including git's timestamp offset — what makes the persisted pre-state
 *  reproduce byte-identical commits on a rebuild. */
export type PersistedCommitIdentity = { name: string; email: string; at: string };

export type ShipOperationPreState =
  | {
      step: 'commit';
      preHead: string;
      preIndexTree: string;
      worktreeFingerprint: string;
      message: string;
      author: PersistedCommitIdentity;
      committer: PersistedCommitIdentity;
      quarantineKey: string;
    }
  | { step: 'push'; localHead: string; remote: string; ref: string; preRemoteHead: string | null }
  | { step: 'describe'; prUrl: string; preBodyHash: string }
  | { step: 'pr'; head: string; base: string | null; preExistingUrl: string | null };

export type ShipOperationIntent =
  | { step: 'commit'; intendedTree: string; expectedHead: string; quarantineKey: string }
  | { step: 'push'; localHead: string; remote: string; ref: string; preRemoteHead: string | null }
  | { step: 'describe'; prUrl: string; preBodyHash: string; intendedBody: string }
  | { step: 'pr'; head: string; base: string | null; title: string; body: string; preExistingUrl: string | null };

const RUN_STATUSES: readonly string[] = ['running', 'passed', 'failed', 'interrupted'];
const STEP_STATUSES: readonly string[] = ['running', 'passed', 'failed', 'note'];
const INTENT_STATUSES: readonly string[] = [
  'preparing',
  'prepared',
  'applied',
  'reconciled',
  'failed',
  'ambiguous',
];

interface ShipRunRowShape {
  id: number;
  ticket_id: number;
  attempt: number;
  status: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

interface ShipRepoStepRowShape {
  id: number;
  ship_run_id: number;
  repo: string;
  step: string;
  status: string;
  detail: string;
  pr_number: number | null;
  existed_before_ship: number | null;
  process_run_id: number | null;
  operation_intent_id: number | null;
  started_at: string;
  ended_at: string | null;
}

interface ShipCommitRowShape {
  id: number;
  ship_run_id: number;
  repo: string;
  sha: string;
  message: string;
  origin: string;
}

interface ShipOperationIntentRowShape {
  id: number;
  ship_run_id: number;
  repo: string;
  step: string;
  operation_key: string;
  pre_state_json: string;
  intent_json: string | null;
  status: string;
  created_at: string;
  prepared_at: string | null;
  applied_at: string | null;
  resolved_at: string | null;
}

function rowToShipRun(r: ShipRunRowShape): ShipRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    attempt: r.attempt,
    // Closed vocabulary at a read boundary: an unrecognized status must never
    // read as `running` (which would authorize a continuation) or as success.
    status: (RUN_STATUSES.includes(r.status) ? r.status : 'failed') as ShipRunStatus,
    pid: r.pid,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function rowToShipRepoStep(r: ShipRepoStepRowShape): ShipRepoStep {
  return {
    id: r.id,
    shipRunId: r.ship_run_id,
    repo: r.repo,
    step: r.step as ShipStep,
    status: (STEP_STATUSES.includes(r.status) ? r.status : 'failed') as ShipStepStatus,
    detail: r.detail,
    prNumber: r.pr_number,
    existedBeforeShip: r.existed_before_ship === null ? null : r.existed_before_ship === 1,
    processRunId: r.process_run_id,
    operationIntentId: r.operation_intent_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function rowToShipCommit(r: ShipCommitRowShape): ShipCommit {
  return {
    id: r.id,
    shipRunId: r.ship_run_id,
    repo: r.repo,
    sha: r.sha,
    message: r.message,
    origin: r.origin,
  };
}

function rowToShipOperationIntent(r: ShipOperationIntentRowShape): ShipOperationIntentRow {
  return {
    id: r.id,
    shipRunId: r.ship_run_id,
    repo: r.repo,
    step: r.step as ShipStep,
    operationKey: r.operation_key,
    preStateJson: r.pre_state_json,
    intentJson: r.intent_json,
    // Unknown data becomes `ambiguous` — the caller's own reconcile
    // vocabulary, so nothing malformed is ever treated as owned or repeatable.
    status: (INTENT_STATUSES.includes(r.status) ? r.status : 'ambiguous') as ShipOperationIntentStatus,
    createdAt: r.created_at,
    preparedAt: r.prepared_at,
    appliedAt: r.applied_at,
    resolvedAt: r.resolved_at,
  };
}

const RUN_SELECT =
  'SELECT id, ticket_id, attempt, status, started_at, ended_at, pid FROM ship_runs';
const STEP_SELECT =
  `SELECT id, ship_run_id, repo, step, status, detail, pr_number,
          existed_before_ship, process_run_id, operation_intent_id,
          started_at, ended_at
     FROM ship_repo_steps`;
const COMMIT_SELECT =
  'SELECT id, ship_run_id, repo, sha, message, origin FROM ship_commits';
const INTENT_SELECT =
  `SELECT id, ship_run_id, repo, step, operation_key, pre_state_json, intent_json,
          status, created_at, prepared_at, applied_at, resolved_at
     FROM ship_operation_intents`;

export interface OpenShipRunInput {
  ticketId: number;
  attempt: number;
  /**
   * The extension host that opened the run (v34) — the process that will run
   * the saga. NULL records no evidence, exactly like a pre-v34 row.
   */
  pid?: number | null;
  startedAt: string;
}

/** Open a ship run as `running` and return it. */
export function openShipRun(store: Store, input: OpenShipRunInput): ShipRun {
  const info = store.db
    .prepare(
      `INSERT INTO ship_runs (ticket_id, attempt, status, started_at, ended_at, pid)
       VALUES (?, ?, 'running', ?, NULL, ?)`,
    )
    .run(input.ticketId, input.attempt, input.startedAt, input.pid ?? null);
  const row = store.db
    .prepare(`${RUN_SELECT} WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ShipRunRowShape | undefined;
  if (row === undefined) throw new Error('ship run insert did not land');
  return rowToShipRun(row);
}

/**
 * Close a ship run with the status it reached. Only a run still `running` is
 * written: a run already closed (or superseded by reconciliation) must never
 * be overwritten by a late finisher.
 */
export function closeShipRun(
  store: Store,
  runId: number,
  status: 'passed' | 'failed' | 'interrupted',
  endedAt: string,
): void {
  store.db
    .prepare(
      `UPDATE ship_runs SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
    )
    .run(status, endedAt, runId);
}

/** A ship this sweep found stranded, reported so the loss is never silent. */
export interface StrandedShipTicket {
  ticketId: number;
  /** The still-`running` ship_runs row; NULL when the run never opened. */
  runId: number | null;
  startedAt: string | null;
  pid: number | null;
}

/**
 * Select the tickets at `ship` whose ship is stranded — the stage row reads
 * `running` (a ship began and never finished) and no in-flight run carries a
 * LIVE pid.
 *
 * A killed ship is otherwise a permanent freeze (869egdr2u-fu1): the ticket
 * sits at `ship` reading `running` with a `running` ship_runs row and no
 * awaiting-merge block, so `settleShipGate` skips it, the drive sweep covers
 * only uat/review, and the dashboard offers no button for a running row.
 * Nothing ever re-drives `shipTicket`, whose saga is built exactly to be
 * re-run (`reconcilePriorShipOperations` adopts or refutes the interrupted
 * run's effects). This is the READ that makes the re-run possible — the host
 * resumes the saga for every ticket listed.
 *
 * Liveness is proven from stored state, never guessed: a run still carrying a
 * live pid is a ship another LIVE window is executing and is left STRICTLY
 * alone. A run with no pid is treated as stranded — absence of evidence is
 * not evidence of life, and the alternative is a freeze that survives every
 * reload (a pre-v34 run, or a host that died before its pid landed).
 */
export function listStrandedShipTickets(
  store: Store,
  isAlive: (pid: number) => boolean,
  scope: ProjectScope = {},
): StrandedShipTicket[] {
  const projectFilter = scope.projectId === undefined ? '' : 'AND t.project_id = ?';
  const projectArgs = scope.projectId === undefined ? [] : [scope.projectId];
  const rows = store.db
    .prepare(
      `SELECT t.id AS ticket_id, r.id AS run_id,
              COALESCE(r.started_at, s.started_at) AS started_at, r.pid AS pid
         FROM tickets t
         JOIN stages s ON s.ticket_id = t.id AND s.stage_key = t.stage_current
         LEFT JOIN ship_runs r ON r.ticket_id = t.id AND r.status = 'running'
        WHERE t.stage_current = 'ship'
          AND s.status = 'running'
          ${projectFilter}
        ORDER BY t.id`,
    )
    .all(...projectArgs) as { ticket_id: number; run_id: number | null; started_at: string | null; pid: number | null }[];

  const stranded: StrandedShipTicket[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.ticket_id)) continue;
    seen.add(row.ticket_id);
    // The ticket's OTHER running runs (a pathological second row) must agree:
    // any live pid anywhere proves the ship is still executing somewhere.
    const siblings = rows.filter((r) => r.ticket_id === row.ticket_id);
    if (siblings.some((r) => r.pid !== null && isAlive(r.pid))) continue;
    stranded.push({
      ticketId: row.ticket_id,
      runId: row.run_id,
      startedAt: row.started_at,
      pid: row.pid,
    });
  }
  return stranded;
}

/** One line naming a ship this sweep found stranded, for the output channel. */
export function describeStrandedShip(s: StrandedShipTicket): string {
  return (
    `karst: ticket ${s.ticketId}: ship ${s.runId === null ? 'stage row' : `run ${s.runId}`} ` +
    `opened ${s.startedAt ?? 'unknown'} (pid ${s.pid ?? 'unknown'}) did not finish — ` +
    `resuming the interrupted ship saga`
  );
}

export interface OpenShipRepoStepInput {
  shipRunId: number;
  repo: string;
  step: ShipStep;
  detail: string;
  processRunId?: number | null;
  startedAt: string;
}

/** Open a (repo, step) row as `running` and return it. */
export function openShipRepoStep(store: Store, input: OpenShipRepoStepInput): ShipRepoStep {
  const info = store.db
    .prepare(
      `INSERT INTO ship_repo_steps
         (ship_run_id, repo, step, status, detail, process_run_id, started_at, ended_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, NULL)`,
    )
    .run(
      input.shipRunId,
      input.repo,
      input.step,
      input.detail,
      input.processRunId ?? null,
      input.startedAt,
    );
  const row = store.db
    .prepare(`${STEP_SELECT} WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ShipRepoStepRowShape | undefined;
  if (row === undefined) throw new Error('ship repo step insert did not land');
  return rowToShipRepoStep(row);
}

export interface FinishShipRepoStepInput {
  status: 'passed' | 'failed' | 'note';
  detail?: string | null;
  prNumber?: number | null;
  existedBeforeShip?: boolean | null;
  endedAt: string;
}

/**
 * Close a (repo, step) row with the status it reached.
 *
 * Only a row still `running` is closed: a late finisher must never overwrite a
 * terminal outcome. Absent values are COALESCEd so they never clobber what a
 * previous close recorded.
 */
export function finishShipRepoStep(store: Store, stepId: number, input: FinishShipRepoStepInput): void {
  store.db
    .prepare(
      `UPDATE ship_repo_steps
          SET status = ?, ended_at = ?,
              detail = COALESCE(?, detail),
              pr_number = COALESCE(?, pr_number),
              existed_before_ship = COALESCE(?, existed_before_ship)
        WHERE id = ? AND status = 'running'`,
    )
    .run(
      input.status,
      input.endedAt,
      input.detail ?? null,
      input.prNumber ?? null,
      input.existedBeforeShip === null || input.existedBeforeShip === undefined
        ? null
        : input.existedBeforeShip
          ? 1
          : 0,
      stepId,
    );
}

export interface RecordShipCommitInput {
  shipRunId: number;
  repo: string;
  sha: string;
  message: string;
  origin: ShipCommitOrigin;
}

/** Record one commit relevant to the ship, tagged with where it came from. */
export function recordShipCommit(store: Store, input: RecordShipCommitInput): void {
  store.db
    .prepare(
      `INSERT INTO ship_commits (ship_run_id, repo, sha, message, origin)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.shipRunId, input.repo, input.sha, input.message, input.origin);
}

export interface BeginShipOperationPreparationInput {
  shipRunId: number;
  repo: string;
  step: ShipStep;
  operationKey: string;
  preState: ShipOperationPreState;
  createdAt: string;
}

/**
 * Persist the complete immutable pre-state BEFORE anything touches git/GitHub,
 * and return the ownership row.
 *
 * `operation_key` is the durable ownership identity, UNIQUE in the table: a
 * crash-and-rerun re-prepares the SAME operation, so this hands back the row
 * already on disk (its persisted pre-state is the only thing that can
 * authorize reconciliation) instead of opening a second ownership claim.
 */
export function beginShipOperationPreparation(
  store: Store,
  input: BeginShipOperationPreparationInput,
): ShipOperationIntentRow {
  const preStateJson = JSON.stringify(input.preState);
  let info: { lastInsertRowid: number | bigint };
  try {
    info = store.db
      .prepare(
        `INSERT INTO ship_operation_intents
           (ship_run_id, repo, step, operation_key, pre_state_json, intent_json,
            status, created_at, prepared_at, applied_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'preparing', ?, NULL, NULL, NULL)`,
      )
      .run(
        input.shipRunId,
        input.repo,
        input.step,
        input.operationKey,
        preStateJson,
        input.createdAt,
      );
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      const existing = store.db
        .prepare(`${INTENT_SELECT} WHERE operation_key = ?`)
        .get(input.operationKey) as ShipOperationIntentRowShape | undefined;
      if (existing !== undefined) return rowToShipOperationIntent(existing);
    }
    throw err;
  }
  const row = store.db
    .prepare(`${INTENT_SELECT} WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as ShipOperationIntentRowShape | undefined;
  if (row === undefined) throw new Error('ship operation intent insert did not land');
  return rowToShipOperationIntent(row);
}

/**
 * Complete the intent half of a `preparing` row (status `prepared`): the exact
 * intended effect, persisted before the apply. Only a row still `preparing`
 * is written — once applied, a late finalize must not rewrite the intent.
 */
export function finalizeShipOperationIntent(
  store: Store,
  intentId: number,
  intent: ShipOperationIntent,
  preparedAt: string,
): void {
  store.db
    .prepare(
      `UPDATE ship_operation_intents
          SET intent_json = ?, status = 'prepared', prepared_at = ?
        WHERE id = ? AND status = 'preparing'`,
    )
    .run(JSON.stringify(intent), preparedAt, intentId);
}

export interface MarkShipOperationAppliedInput {
  appliedAt: string;
  resolvedAt?: string | null;
}

/**
 * Mark an intent `applied` once the external side effect has returned. Only a
 * row still `preparing`/`prepared` is written. An optional `resolvedAt` stamps
 * the moment the apply itself proved the effect (a deterministic adoption);
 * the row stays `applied` until a reconcile closes it.
 */
export function markShipOperationApplied(
  store: Store,
  intentId: number,
  input: MarkShipOperationAppliedInput,
): void {
  store.db
    .prepare(
      `UPDATE ship_operation_intents
          SET status = 'applied', applied_at = ?,
              resolved_at = COALESCE(?, resolved_at)
        WHERE id = ? AND status IN ('preparing','prepared')`,
    )
    .run(input.appliedAt, input.resolvedAt ?? null, intentId);
}

export interface ReconcileShipOperationInput {
  resolvedAt: string;
  /** The human-facing WHY; lands on the still-running step row the panel
   *  renders (the intents table has no detail column). Optional. */
  detail?: string | null;
}

/**
 * Close an intent with its terminal reconcile verdict. Only a row still
 * `preparing`/`prepared`/`applied` is written; a terminal verdict is never
 * rewritten. A provided `detail` is recorded on the matching step row while it
 * is still `running` — a finished step's terminal detail is never overwritten.
 */
export function reconcileShipOperation(
  store: Store,
  intentId: number,
  status: ShipOperationReconcileStatus,
  input: ReconcileShipOperationInput,
): void {
  store.db
    .prepare(
      `UPDATE ship_operation_intents
          SET status = ?, resolved_at = ?
        WHERE id = ? AND status IN ('preparing','prepared','applied')`,
    )
    .run(status, input.resolvedAt, intentId);

  if (input.detail !== undefined && input.detail !== null) {
    const row = store.db
      .prepare(`${INTENT_SELECT} WHERE id = ?`)
      .get(intentId) as ShipOperationIntentRowShape | undefined;
    if (row !== undefined) {
      store.db
        .prepare(
          `UPDATE ship_repo_steps
              SET detail = ?
            WHERE ship_run_id = ? AND repo = ? AND step = ? AND status = 'running'`,
        )
        .run(input.detail, row.ship_run_id, row.repo, row.step);
    }
  }
}

export interface AdoptShipOperationInput {
  stepId: number;
  detail: string;
  prNumber?: number | null;
  existedBeforeShip?: boolean | null;
  at: string;
}

/**
 * ADOPT a step and its intent because the persisted intended effect was
 * verified present in the world (the reconcile verdict `reconciled`).
 *
 * Deliberately a SEPARATE writer from `reconcileShipOperation`: adoption is
 * the one reconcile verdict that must be able to close a step the crashed run
 * already closed `failed`/`ambiguous` — a commit that landed before the crash
 * is a landed commit no matter how the run that made it ended. Only an
 * already-`reconciled` intent and an already-`passed` step are left alone;
 * anything else is writable, because the effect was just re-verified.
 */
export function adoptShipOperation(
  store: Store,
  intentId: number,
  input: AdoptShipOperationInput,
): void {
  store.db
    .prepare(
      `UPDATE ship_operation_intents
          SET status = 'reconciled', resolved_at = ?
        WHERE id = ? AND status != 'reconciled'`,
    )
    .run(input.at, intentId);
  store.db
    .prepare(
      `UPDATE ship_repo_steps
          SET status = 'passed', ended_at = ?,
              detail = COALESCE(?, detail),
              pr_number = COALESCE(?, pr_number),
              existed_before_ship = COALESCE(?, existed_before_ship)
        WHERE id = ? AND status != 'passed'`,
    )
    .run(
      input.at,
      input.detail,
      input.prNumber ?? null,
      input.existedBeforeShip === null || input.existedBeforeShip === undefined
        ? null
        : input.existedBeforeShip
          ? 1
          : 0,
      input.stepId,
    );
}

/** A step as the evidence view exposes it — a running step without a matching
 *  intent row is flagged so the caller refuses to prepare for it. */
export interface ShipRepoStepEvidence extends ShipRepoStep {
  /** A durable ownership row exists for this (run, repo, step). */
  hasIntent: boolean;
  /** The PR number of a `pr` step (alias of `prNumber`), shaped for the panel:
   *  `repos.web.pr.number` reads the PR. NULL until the step carries one. */
  number: number | null;
}

export interface ShipRepoEvidence
  extends Partial<Record<ShipStep, ShipRepoStepEvidence>> {
  /** Keyed by step name, and the same rows are ALSO flattened onto the repo
   *  evidence itself: `repos.web.push.status` reads the push step. */
  steps: Partial<Record<ShipStep, ShipRepoStepEvidence>>;
  /** Every commit recorded for the repo, insertion order. */
  commits: ShipCommit[];
  /** Keyed by step name, mirroring `steps`. */
  intents: Partial<Record<ShipStep, ShipOperationIntentRow>>;
}

export interface ShipEvidence {
  /** The LATEST ship run for the ticket; undefined when it never shipped. */
  run: ShipRun | undefined;
  repos: Record<string, ShipRepoEvidence>;
}

/**
 * One ship commit by its row id, whatever ticket it belongs to — the
 * typed-action dispatch reloads the row by host-owned id and verifies the
 * ticket itself (`insideActions.ts`). The owning ticket is carried via the
 * commit's ship run (commits have no ticket column of their own).
 */
export function getShipCommitById(
  store: Store,
  id: number,
): (ShipCommit & { ticketId: number }) | undefined {
  const row = store.db
    .prepare(
      `SELECT c.id, c.ship_run_id, c.repo, c.sha, c.message, c.origin, r.ticket_id AS ticket_id
         FROM ship_commits c
         JOIN ship_runs r ON r.id = c.ship_run_id
        WHERE c.id = ?`,
    )
    .get(id) as (ShipCommitRowShape & { ticket_id: number }) | undefined;
  if (row === undefined) return undefined;
  return { ...rowToShipCommit(row), ticketId: row.ticket_id };
}/**
 * The evidence view of the ticket's LATEST ship run, grouped per repository.
 *
 * The run is picked by greatest id — insertion order IS run order. Steps and
 * intents are keyed by step name (the saga walks each step at most once per
 * run per repo), commits keep insertion order.
 */
export function listShipEvidence(store: Store, ticketId: number): ShipEvidence {
  const runRow = store.db
    .prepare(`${RUN_SELECT} WHERE ticket_id = ? ORDER BY id DESC LIMIT 1`)
    .get(ticketId) as ShipRunRowShape | undefined;
  if (runRow === undefined) return { run: undefined, repos: {} };
  const run = rowToShipRun(runRow);

  const steps = store.db
    .prepare(`${STEP_SELECT} WHERE ship_run_id = ? ORDER BY id`)
    .all(run.id)
    .map((r) => rowToShipRepoStep(r as ShipRepoStepRowShape));
  const commits = store.db
    .prepare(`${COMMIT_SELECT} WHERE ship_run_id = ? ORDER BY id`)
    .all(run.id)
    .map((r) => rowToShipCommit(r as ShipCommitRowShape));
  const intents = store.db
    .prepare(`${INTENT_SELECT} WHERE ship_run_id = ? ORDER BY id`)
    .all(run.id)
    .map((r) => rowToShipOperationIntent(r as ShipOperationIntentRowShape));

  const repos: Record<string, ShipRepoEvidence> = {};
  const repoEv = (repo: string): ShipRepoEvidence => {
    let e = repos[repo];
    if (e === undefined) {
      e = { steps: {}, commits: [], intents: {} };
      repos[repo] = e;
    }
    return e;
  };
  const intentKeys = new Set(intents.map((i) => `${i.shipRunId}:${i.repo}:${i.step}`));
  for (const s of steps) {
    const e = repoEv(s.repo);
    const evidence: ShipRepoStepEvidence = {
      ...s,
      hasIntent: intentKeys.has(`${s.shipRunId}:${s.repo}:${s.step}`),
      number: s.prNumber,
    };
    e.steps[s.step] = evidence;
    // The same row also answers `repos.web.push` directly.
    e[s.step] = evidence;
  }
  for (const c of commits) repoEv(c.repo).commits.push(c);
  for (const i of intents) repoEv(i.repo).intents[i.step] = i;

  return { run, repos };
}

/**
 * How many ship runs a ticket has recorded, in total. `listShipEvidence` keeps
 * only the LATEST run; the artifact model counts runs as VERSIONS of the one
 * ship-summary artifact, so the total is a separate, cheaper read.
 */
export function countShipRuns(store: Store, ticketId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM ship_runs WHERE ticket_id = ?')
    .get(ticketId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** The step detail a sweep-closed step carries. */
const INTERRUPTED_STEP_DETAIL = 'interrupted — the host that ran it died; retry ship to continue';

/** The stage verdict a sweep-parked ship carries, surfaced by the dashboard. */
const INTERRUPTED_STAGE_VERDICT =
  'ship was interrupted — the host that ran it died before the PRs opened; retry ship to continue';

/** A run this sweep found dead, reported so the loss is never silent. */
export interface StaleShipRun {
  run: ShipRun;
  reason: string;
}

/**
 * Mark every ship run whose process is gone as `interrupted`, globally.
 *
 * A ship run killed by process death (an extension-host crash mid-saga) is a
 * state nothing can leave on its own: the saga's crash-and-retry
 * reconciliation runs only at the START of the next `shipTicket` invocation,
 * and the ticket at `ship` `running` with no block offers no retry anywhere —
 * the Now line shows no button for a running ship, and no sweep re-drives a
 * user-confirmed stage. Closing the dead run and parking the stage `failed`
 * is what turns "a ship that has been running for a day with no PR" into the
 * one state that HAS a recovery path: the existing failed-ship surface, whose
 * Now line offers "Retry ship" and whose retry re-invokes the saga, which
 * reconciles what the dead run persisted and redoes what never landed.
 *
 * Global like `reconcileStageRuns` and safe for the same reason: attribution,
 * not scope. A run opened by ANOTHER LIVE window has a live pid and is left
 * strictly alone; a run with no recorded pid is left alone too, because
 * absence of evidence is not evidence that it died. Every write is guarded —
 * an already-closed run is never rewritten, and the stage row is only parked
 * when it still reads `running` AND unblocked, so a ticket parked
 * `awaiting-merge` beside a dead re-run keeps its parked state.
 *
 * Reported, never silent — an invisibly-discarded run is the whole failure
 * this closes, and a sweep that quietly corrected the data would repeat it.
 */
export function reconcileShipRuns(
  store: Store,
  isAlive: (pid: number) => boolean,
  now: string,
): StaleShipRun[] {
  const rows = store.db
    .prepare(`${RUN_SELECT} WHERE status = 'running' ORDER BY id`)
    .all()
    .map((r) => rowToShipRun(r as ShipRunRowShape));

  const stale: StaleShipRun[] = [];
  const markRun = store.db.prepare(
    "UPDATE ship_runs SET status = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'",
  );
  const markSteps = store.db.prepare(
    `UPDATE ship_repo_steps SET status = 'failed', detail = ?, ended_at = ?
      WHERE ship_run_id = ? AND status = 'running'`,
  );
  const stageRow = store.db.prepare(
    "SELECT status, blocked_kind FROM stages WHERE ticket_id = ? AND stage_key = 'ship'",
  );
  for (const run of rows) {
    if (run.pid === null) continue;
    if (isAlive(run.pid)) continue;
    const apply = store.db.transaction(() => {
      markRun.run(now, run.id);
      markSteps.run(INTERRUPTED_STEP_DETAIL, now, run.id);
      const stage = stageRow.get(run.ticketId) as
        | { status: string; blocked_kind: string | null }
        | undefined;
      // The single-writer rule is still honoured — `setStage` is the only
      // stage writer; the guarded read only decides whether to call it.
      if (stage !== undefined && stage.status === 'running' && stage.blocked_kind === null) {
        setStage(store, run.ticketId, 'ship', {
          status: 'failed',
          verdict: INTERRUPTED_STAGE_VERDICT,
          endedAt: now,
        });
      }
    });
    apply();
    stale.push({
      run: { ...run, status: 'interrupted' },
      reason:
        `${run.startedAt} ship run (pid ${run.pid}) did not finish — its process is gone; ` +
        'ship is parked failed so a retry can resume it',
    });
  }
  return stale;
}

/** One line naming a run this sweep found dead, for the output channel. */
export function describeStaleShipRun(s: StaleShipRun): string {
  return `karst: ticket ${s.run.ticketId}: ${s.reason}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStrOrNull(v: unknown): v is string | null {
  return v === null || isStr(v);
}

function isIdentity(v: unknown): v is PersistedCommitIdentity {
  return isRecord(v) && isStr(v.name) && isStr(v.email) && isStr(v.at);
}

/**
 * Parse a persisted `pre_state_json` through the closed per-step union.
 *
 * Returns null on ANY malformed/unknown data — a step that does not match, a
 * missing or mistyped field, a foreign shape. The caller turns that null into
 * `ambiguous`: nothing malformed is ever treated as owned, repeatable, or
 * cleanable.
 */
export function parseShipPreState(
  json: string | null | undefined,
  step: ShipStep,
): ShipOperationPreState | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.step !== step) return null;

  switch (step) {
    case 'commit': {
      const { preHead, preIndexTree, worktreeFingerprint, message, author, committer, quarantineKey } =
        parsed;
      if (
        !isStr(preHead) ||
        !isStr(preIndexTree) ||
        !isStr(worktreeFingerprint) ||
        !isStr(message) ||
        !isIdentity(author) ||
        !isIdentity(committer) ||
        !isStr(quarantineKey)
      ) {
        return null;
      }
      return {
        step,
        preHead,
        preIndexTree,
        worktreeFingerprint,
        message,
        author,
        committer,
        quarantineKey,
      };
    }
    case 'push': {
      const { localHead, remote, ref, preRemoteHead } = parsed;
      if (!isStr(localHead) || !isStr(remote) || !isStr(ref) || !isStrOrNull(preRemoteHead)) {
        return null;
      }
      return { step, localHead, remote, ref, preRemoteHead };
    }
    case 'describe': {
      const { prUrl, preBodyHash } = parsed;
      if (!isStr(prUrl) || !isStr(preBodyHash)) return null;
      return { step, prUrl, preBodyHash };
    }
    case 'pr': {
      const { head, base, preExistingUrl } = parsed;
      if (!isStr(head) || !isStrOrNull(base) || !isStrOrNull(preExistingUrl)) return null;
      return { step, head, base, preExistingUrl };
    }
    default:
      // An unknown step (a foreign writer or a future vocabulary) is malformed
      // data, never a union member.
      return null;
  }
}

/**
 * Parse a persisted `intent_json` through the closed per-step union, exactly
 * like `parseShipPreState` — malformed/unknown data is null, never adopted.
 */
export function parseShipIntent(
  json: string | null | undefined,
  step: ShipStep,
): ShipOperationIntent | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.step !== step) return null;

  switch (step) {
    case 'commit': {
      const { intendedTree, expectedHead, quarantineKey } = parsed;
      if (!isStr(intendedTree) || !isStr(expectedHead) || !isStr(quarantineKey)) return null;
      return { step, intendedTree, expectedHead, quarantineKey };
    }
    case 'push': {
      const { localHead, remote, ref, preRemoteHead } = parsed;
      if (!isStr(localHead) || !isStr(remote) || !isStr(ref) || !isStrOrNull(preRemoteHead)) {
        return null;
      }
      return { step, localHead, remote, ref, preRemoteHead };
    }
    case 'describe': {
      const { prUrl, preBodyHash, intendedBody } = parsed;
      if (!isStr(prUrl) || !isStr(preBodyHash) || !isStr(intendedBody)) return null;
      return { step, prUrl, preBodyHash, intendedBody };
    }
    case 'pr': {
      const { head, base, title, body, preExistingUrl } = parsed;
      if (
        !isStr(head) ||
        !isStrOrNull(base) ||
        !isStr(title) ||
        !isStr(body) ||
        !isStrOrNull(preExistingUrl)
      ) {
        return null;
      }
      return { step, head, base, title, body, preExistingUrl };
    }
    default:
      return null;
  }
}
