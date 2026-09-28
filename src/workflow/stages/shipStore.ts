import type { Store } from '../../store/db.js';
import {
  beginShipOperationPreparation,
  openShipRepoStep,
  type ShipOperationPreState,
  type ShipRun,
} from '../../store/shipRuns.js';

/**
 * The raw SQLite access `shipTicket` and its helpers need — every inline
 * `store.db.prepare(...)` in the ship stage, gathered in one place (NDL-40)
 * so the orchestration file (`ship.ts`) reads as PR/git/saga flow rather than
 * a mix of that flow and ad-hoc SQL. Pure extraction: every query, its shape,
 * and its call sites are unchanged — only where the SQL text lives moved.
 */

/** One step of ship's per-repo work, in the order it happens. */
export type ShipStep = 'commit' | 'push' | 'describe' | 'pr' | 'merge';

/**
 * One structured progress event. `note` marks a step that was not (re-)run —
 * an idempotent retry adopting an already-open PR — so the live view never
 * claims work happened that didn't.
 */
export interface ShipStepEvent {
  repo: string;
  step: ShipStep;
  status: 'run' | 'pass' | 'fail' | 'note';
  detail?: string;
}

/**
 * Structured progress emitted as the ship progresses. Deliberately
 * non-throwing at the call sites (the caller's UI is observing, not controlling)
 * — a broken observer must never sink a ship that otherwise works.
 */
export type ShipProgress = (event: ShipStepEvent) => void;

/** Open the durable step row and its pre-state ownership row in ONE transaction. */
export function openStepWithPreparation(
  store: Store,
  input: {
    run: ShipRun;
    repo: string;
    step: 'commit' | 'push' | 'describe' | 'pr';
    operationKey: string;
    preState: ShipOperationPreState;
    detail: string;
    processRunId?: number | null;
    at: string;
  },
): { stepId: number; intentId: number } {
  let stepId = 0;
  let intentId = 0;
  store.db.transaction(() => {
    const step = openShipRepoStep(store, {
      shipRunId: input.run.id,
      repo: input.repo,
      step: input.step,
      detail: input.detail,
      processRunId: input.processRunId ?? null,
      startedAt: input.at,
    });
    const intent = beginShipOperationPreparation(store, {
      shipRunId: input.run.id,
      repo: input.repo,
      step: input.step,
      operationKey: input.operationKey,
      preState: input.preState,
      createdAt: input.at,
    });
    // The step's ownership link: reconciliation loads the intent through it.
    // A running step without this link authorizes nothing.
    store.db
      .prepare('UPDATE ship_repo_steps SET operation_intent_id = ? WHERE id = ?')
      .run(intent.id, step.id);
    stepId = step.id;
    intentId = intent.id;
  })();
  return { stepId, intentId };
}

/** Whether this ship run already recorded a commit at this exact SHA (idempotent adoption). */
export function shipCommitRecorded(store: Store, runId: number, repo: string, sha: string): boolean {
  const exists = store.db
    .prepare('SELECT id FROM ship_commits WHERE ship_run_id = ? AND repo = ? AND sha = ?')
    .get(runId, repo, sha);
  return exists !== undefined;
}

/** The most recent ship run for this ticket that started before the current one, if any. */
export function findPriorShipRun(
  store: Store,
  ticketId: number,
  currentRunId: number,
): { id: number; status: string } | undefined {
  return store.db
    .prepare(
      'SELECT id, status FROM ship_runs WHERE ticket_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
    )
    .get(ticketId, currentRunId) as { id: number; status: string } | undefined;
}

export interface UnfinishedShipRepoStepRow {
  id: number;
  repo: string;
  step: string;
  operation_intent_id: number | null;
}

/** Every step of a ship run that never reached `passed` — the reconciliation work list. */
export function listUnfinishedShipRepoSteps(
  store: Store,
  shipRunId: number,
): UnfinishedShipRepoStepRow[] {
  return store.db
    .prepare(
      `SELECT id, repo, step, operation_intent_id
         FROM ship_repo_steps
        WHERE ship_run_id = ? AND status != 'passed'`,
    )
    .all(shipRunId) as UnfinishedShipRepoStepRow[];
}

export interface ShipOperationIntentRow {
  id: number;
  status: string;
  pre_state_json: string;
  intent_json: string | null;
  repo: string;
  ship_run_id: number;
}

/** The typed ownership row backing one interrupted step, by its id. */
export function getShipOperationIntentRow(
  store: Store,
  intentId: number,
): ShipOperationIntentRow | undefined {
  return store.db
    .prepare(
      `SELECT id, status, pre_state_json, intent_json, repo, ship_run_id
         FROM ship_operation_intents WHERE id = ?`,
    )
    .get(intentId) as ShipOperationIntentRow | undefined;
}

/**
 * Whether this ticket has ever COMPLETED a ship — a `passed` `ship_runs` row.
 *
 * This is the production signal that the next ship is a RE-SHIP: a ticket's
 * FIRST ship has no such run, while a ticket that already opened a PR, went
 * back through fix, and reached `ship` again does. The host seam
 * (`runShipSaga`) reads it for a USER-INITIATED ship to turn on
 * `deliverToOpenPr` — the unattended stranded resume asks
 * `activeRecoverySeries` instead — so the new commits are
 * committed and pushed onto the PR already open for a repo instead of being
 * skipped as if the work had already been delivered (FIX-46).
 *
 * A crash-resume whose first ship never completed has no `passed` run, so it
 * keeps the default skip; a retry after a FAILED ship likewise. That is
 * deliberate — only a ship that genuinely completed once is a re-ship.
 */
export function hasCompletedShipRun(store: Store, ticketId: number): boolean {
  const row = store.db
    .prepare("SELECT 1 AS one FROM ship_runs WHERE ticket_id = ? AND status = 'passed' LIMIT 1")
    .get(ticketId);
  return row !== undefined;
}

export interface LivePrRow {
  repo: string;
  number: number | null;
  url: string;
}

/**
 * A PR row for this ticket/repo that is still LIVE — not just 'open':
 * `updatePrDetail` overwrites `status` with the PR's real upstream state
 * right after this row is created (e.g. 'draft' for a draft PR), so matching
 * only 'open' misses it on the very next retry (Defect 3). 'closed'/'merged'
 * are the only terminal states; everything else — 'open', 'draft', 'unknown',
 * or NULL (never probed) — is still live.
 */
export function findExistingLivePr(store: Store, ticketId: number, repo: string): LivePrRow | undefined {
  return store.db
    .prepare(
      `SELECT repo, number, url FROM prs
        WHERE ticket_id = ? AND repo = ?
          AND (status IS NULL OR status NOT IN ('closed', 'merged'))`,
    )
    .get(ticketId, repo) as LivePrRow | undefined;
}

/** The merged PR row for this ticket/repo, if the ticket already shipped and merged one. */
export function findMergedPr(store: Store, ticketId: number, repo: string): LivePrRow | undefined {
  return store.db
    .prepare(
      `SELECT repo, number, url FROM prs
        WHERE ticket_id = ? AND repo = ? AND status = 'merged'`,
    )
    .get(ticketId, repo) as LivePrRow | undefined;
}

/** How many ship runs this ticket has ever opened, including the one about to start. */
export function countShipRuns(store: Store, ticketId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM ship_runs WHERE ticket_id = ?')
    .get(ticketId) as { n: number };
  return row.n;
}
