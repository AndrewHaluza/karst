import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';

/**
 * `process_runs` (v26) — one row per inside-process INVOCATION, opened before
 * the process starts and closed at its outcome.
 *
 * The inside redesign renders a stage as ordered PROCESSES (gates, commit,
 * delivery-receipt, recovery…), each carrying an AI identity snapshot and its
 * own evidence. The evidence tables (`gate_runs`, `review_findings`) record
 * what FINISHED; only a row opened at entry can say a process ran at all — the
 * same gap `stage_runs` closed for gate runs, one level down. It is also the
 * only place the identity that actually ran (agent/provider/model) is captured
 * as it resolved at launch, immutable thereafter.
 *
 * A run is never deleted and never rewritten into a lie. `stale` is what a run
 * killed by process death becomes — a real, recordable fact, and the one the
 * user was owed while a process re-ran invisibly from scratch.
 */
export type ProcessRunStatus = 'running' | 'passed' | 'failed' | 'interrupted' | 'stale';

/** The statuses a run can be CLOSED with. `stale` is never chosen, only found. */
export type ProcessRunFinishStatus = 'passed' | 'failed' | 'interrupted';

export interface ProcessRun {
  id: number;
  ticketId: number;
  stageKey: StageKey;
  /** The inside-process identity — `gates`, `commit`, `delivery-receipt`. */
  processId: string;
  /** The stage's attempt when this run opened — pre-bump, like `gate_runs`. */
  attempt: number;
  /** The stage_runs batch this process ran under, when one was opened. */
  stageRunId: number | null;
  /** Identity SNAPSHOT: the agent that ran, as resolved at launch. Immutable. */
  agentName: string | null;
  /** Identity SNAPSHOT: the provider that ran. Immutable. */
  provider: string | null;
  /** Identity SNAPSHOT: the model that ran. Immutable. */
  model: string | null;
  /**
   * The process that opened the run. NULL = unknown, never invented. Used only
   * to decide liveness at activation, and a pid is a recollection, not a handle
   * — the reconcile below acts on it exactly as conservatively as
   * `runtime/serverIdentity.ts` does.
   */
  pid: number | null;
  status: ProcessRunStatus;
  /** The outcome's verdict kind, when the process has one. Never backfilled. */
  resultKind: string | null;
  /** Path of the artifact the process produced, if any. Never backfilled. */
  artifactPath: string | null;
  startedAt: string;
  /**
   * NULL while running AND on a stale run. When a killed run stopped is
   * genuinely unknown — writing the reconcile's own clock there would claim the
   * run lived until the next activation, which may be days.
   */
  endedAt: string | null;
}

interface ProcessRunRow {
  id: number;
  ticket_id: number;
  stage_key: string;
  process_id: string;
  attempt: number;
  stage_run_id: number | null;
  agent_name: string | null;
  provider: string | null;
  model: string | null;
  pid: number | null;
  status: string;
  result_kind: string | null;
  artifact_path: string | null;
  started_at: string;
  ended_at: string | null;
}

const STATUSES: readonly string[] = ['running', 'passed', 'failed', 'interrupted', 'stale'];

function rowToProcessRun(r: ProcessRunRow): ProcessRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    stageKey: r.stage_key as StageKey,
    processId: r.process_id,
    attempt: r.attempt,
    stageRunId: r.stage_run_id,
    agentName: r.agent_name,
    provider: r.provider,
    model: r.model,
    pid: r.pid,
    // Closed vocabulary at a read boundary over an append-only table: an
    // unrecognized value degrades to the conservative answer rather than being
    // carried through as a state no consumer handles.
    status: (STATUSES.includes(r.status) ? r.status : 'stale') as ProcessRunStatus,
    resultKind: r.result_kind,
    artifactPath: r.artifact_path,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const SELECT =
  `SELECT id, ticket_id, stage_key, process_id, attempt, stage_run_id,
          agent_name, provider, model, pid, status, result_kind, artifact_path,
          started_at, ended_at
     FROM process_runs`;

export interface OpenProcessRunInput {
  ticketId: number;
  stageKey: StageKey;
  processId: string;
  attempt: number;
  stageRunId?: number | null;
  agentName?: string | null;
  provider?: string | null;
  model?: string | null;
  pid?: number | null;
  resultKind?: string | null;
  artifactPath?: string | null;
  startedAt: string;
}

/**
 * Open a run and return it.
 *
 * Any run of the same ticket+stage+process still marked `running` is marked
 * `stale` first, in the same transaction: a second run of the same process
 * cannot start while the first is genuinely live (the driver single-flights per
 * ticket), so one still open here is one whose host died. Marking it at the
 * moment it is SUPERSEDED is what makes the re-run visible — the alternative,
 * waiting for an activation sweep, leaves the destroyed run reading `running`
 * beside the run that replaced it.
 *
 * A run of a DIFFERENT process (a sibling inside the same stage) is left
 * alone: processes run concurrently, so a new `commit` run must never accuse a
 * live `review` run of having died.
 */
export function openProcessRun(store: Store, input: OpenProcessRunInput): ProcessRun {
  let insertedId = 0;
  const apply = store.db.transaction(() => {
    store.db
      .prepare(
        `UPDATE process_runs SET status = 'stale'
          WHERE ticket_id = ? AND stage_key = ? AND process_id = ? AND status = 'running'`,
      )
      .run(input.ticketId, input.stageKey, input.processId);
    const info = store.db
      .prepare(
        `INSERT INTO process_runs
           (ticket_id, stage_key, process_id, attempt, stage_run_id,
            agent_name, provider, model, pid, status, result_kind, artifact_path,
            started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL)`,
      )
      .run(
        input.ticketId,
        input.stageKey,
        input.processId,
        input.attempt,
        input.stageRunId ?? null,
        input.agentName ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.pid ?? null,
        input.resultKind ?? null,
        input.artifactPath ?? null,
        input.startedAt,
      );
    insertedId = Number(info.lastInsertRowid);
  });
  apply();
  const row = store.db
    .prepare(`${SELECT} WHERE id = ?`)
    .get(insertedId) as ProcessRunRow | undefined;
  if (row === undefined) throw new Error('process run insert did not land');
  return rowToProcessRun(row);
}

/**
 * Close a run with the status it reached.
 *
 * Only a run still `running` is closed: a run already marked `stale` was
 * superseded, and letting a late finisher overwrite that would erase the very
 * fact the table records. Only the status and its end are written — the
 * identity snapshot is immutable and nothing here may touch it.
 */
export function finishProcessRun(
  store: Store,
  runId: number,
  status: ProcessRunFinishStatus,
  endedAt: string,
): void {
  store.db
    .prepare(
      `UPDATE process_runs SET status = ?, ended_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(status, endedAt, runId);
}

/** Every run recorded for a ticket, oldest first (insertion order is run order). */
export function listProcessRuns(store: Store, ticketId: number): ProcessRun[] {
  return store.db
    .prepare(`${SELECT} WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId)
    .map((r) => rowToProcessRun(r as ProcessRunRow));
}

/** A run this sweep found dead, reported so the loss is never silent. */
export interface StaleProcessRun {
  run: ProcessRun;
  reason: string;
}

/**
 * Mark every `running` row whose process is gone as `stale`, globally.
 *
 * Global like `reconcileStageRuns` and for the same reason: the registry is
 * shared by every IDE window, and a run whose host died is wrong in whichever
 * project owns it. What makes that safe is `isAlive`, not the scope — a run
 * opened by ANOTHER LIVE window has a live pid and is left strictly alone. A
 * row with no pid is left alone too: absence of evidence is not evidence the
 * run is dead, and marking one stale would falsely accuse a live run of having
 * been destroyed.
 *
 * Reported, never silent. An invisibly-discarded run is the whole failure this
 * closes; a sweep that fixed the data and said nothing would repeat it.
 */
export function reconcileProcessRuns(
  store: Store,
  isAlive: (pid: number) => boolean,
): StaleProcessRun[] {
  const rows = store.db
    .prepare(`${SELECT} WHERE status = 'running' ORDER BY id`)
    .all()
    .map((r) => rowToProcessRun(r as ProcessRunRow));

  const stale: StaleProcessRun[] = [];
  const mark = store.db.prepare("UPDATE process_runs SET status = 'stale' WHERE id = ?");
  for (const run of rows) {
    if (run.pid === null) continue;
    if (isAlive(run.pid)) continue;
    mark.run(run.id);
    stale.push({
      run: { ...run, status: 'stale' },
      reason:
        `${run.stageKey} process ${run.processId} run opened ${run.startedAt} ` +
        `(pid ${run.pid}) did not finish — its process is gone; it will run again`,
    });
  }
  return stale;
}

/** One line naming a run this sweep found dead, for the output channel. */
export function describeStaleProcessRun(s: StaleProcessRun): string {
  return `karst: ticket ${s.run.ticketId}: ${s.reason}`;
}
